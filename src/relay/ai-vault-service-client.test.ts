import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import {
  AiVaultServiceTestChild,
  readyAiVaultServiceChild
} from '../main/ai-vault/session-scanner-service-test-child'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'
import { RELAY_AI_VAULT_READY_TIMEOUT_MS } from './ai-vault-service-client-state'
import { relayAiVaultServiceEntryPath } from './ai-vault-service-spawn'

function createClient(
  children: AiVaultServiceTestChild[],
  idleTimeoutMs?: number
): RelayAiVaultServiceClient {
  return new RelayAiVaultServiceClient({
    init: {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    },
    processFactory: () => {
      const child = new AiVaultServiceTestChild(20_000 + children.length)
      children.push(child)
      return child.asChildProcess()
    },
    idleTimeoutMs
  })
}

function relayRequests(child: AiVaultServiceTestChild, operation: string): { id: number }[] {
  return child.sent.filter(
    (message) => (message as { operation?: string }).operation === operation
  ) as { id: number }[]
}

function relayRequestCount(child: AiVaultServiceTestChild, operation: string): number {
  return relayRequests(child, operation).length
}

function relayRequestId(child: AiVaultServiceTestChild, operation: string): number {
  const request = relayRequests(child, operation).at(-1)
  if (!request) {
    throw new Error(`No ${operation} request was sent.`)
  }
  return request.id
}

afterEach(() => vi.useRealTimers())

describe('RelayAiVaultServiceClient', () => {
  it('holds list and title calls behind the ready handshake', async () => {
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const list = client.listSessions({ limit: 20 })
    const titles = client.resolveSessionTitles([])
    const child = children[0]!

    expect(child.sent).toEqual([expect.objectContaining({ type: 'init', protocol: 1 })])
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const listRequest = child.sent.find(
      (message) => (message as { operation?: string }).operation === 'list'
    ) as { id: number }
    child.emit('message', {
      type: 'result',
      id: listRequest.id,
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await expect(list).resolves.toMatchObject({ sessions: [] })
    const titleRequest = child.sent.find(
      (message) => (message as { operation?: string }).operation === 'titles'
    ) as { id: number }
    child.emit('message', {
      type: 'result',
      id: titleRequest.id,
      operation: 'titles',
      value: { titles: [] }
    })
    await expect(titles).resolves.toEqual({ titles: [] })
    const disposing = client.dispose()
    child.emit('exit', 0)
    await disposing
  })

  it('resolves titles while a scan still occupies the cache lane', async () => {
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const list = client.listSessions({})
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()

    const titles = client.resolveSessionTitles([
      { agent: 'claude', sessionId: 'session-1', transcriptPath: '/home/ada/session-1.jsonl' }
    ])
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: relayRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })

    await expect(titles).resolves.toEqual({ titles: [] })
    child.emit('message', {
      type: 'result',
      id: relayRequestId(child, 'list'),
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await expect(list).resolves.toMatchObject({ sessions: [] })
    const disposing = client.dispose()
    child.emit('exit', 0)
    await disposing
  })

  it('does not start queued cache work until cancelled work acknowledges', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const controller = new AbortController()
    const first = client.listSessions({}, controller.signal)
    const second = client.listSessions({ limit: 5 })
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const firstRequest = relayRequestId(child, 'list')

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(relayRequestCount(child, 'list')).toBe(1)
    child.emit('message', {
      type: 'error',
      id: firstRequest,
      message: 'aborted'
    })
    await Promise.resolve()
    expect(relayRequestCount(child, 'list')).toBe(2)
    void second.catch(() => undefined)
    const disposing = client.dispose()
    child.emit('exit', 0)
    await disposing
  })

  it('drops a call cancelled before the sidecar received it', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const controller = new AbortController()
    const cancelled = client.listSessions({}, controller.signal)
    const child = children[0]!

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).not.toContainEqual(expect.objectContaining({ type: 'cancel' }))

    readyAiVaultServiceChild(child)
    const next = client.listSessions({ limit: 5 })
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: relayRequestId(child, 'list'),
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await expect(next).resolves.toMatchObject({ sessions: [] })
    vi.advanceTimersByTime(2_000)

    expect(child.killed).toBe(false)
    const disposing = client.dispose()
    child.emit('exit', 0)
    await disposing
  })

  it('retries a cold-start crash once without faulting the replacement sidecar', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const list = client.listSessions({})

    children[0]!.emit('exit', 1)
    await Promise.resolve()
    vi.advanceTimersByTime(250)
    expect(children).toHaveLength(2)
    readyAiVaultServiceChild(children[1]!)
    await Promise.resolve()
    vi.advanceTimersByTime(RELAY_AI_VAULT_READY_TIMEOUT_MS)

    expect(children[1]!.killed).toBe(false)
    children[1]!.emit('message', {
      type: 'result',
      id: relayRequestId(children[1]!, 'list'),
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await expect(list).resolves.toMatchObject({ sessions: [] })
    const disposing = client.dispose()
    children[1]!.emit('exit', 0)
    await disposing
  })

  it('keeps the sidecar alive once a cancelled call acknowledges', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const controller = new AbortController()
    const first = client.listSessions({}, controller.signal)
    const second = client.resolveSessionTitles([])
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const firstRequest = child.sent.find(
      (message) => (message as { operation?: string }).operation === 'list'
    ) as { id: number }

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    child.emit('message', { type: 'error', id: firstRequest.id, message: 'aborted' })
    await Promise.resolve()
    vi.advanceTimersByTime(2_000)

    expect(child.killed).toBe(false)
    const titleRequest = child.sent.find(
      (message) => (message as { operation?: string }).operation === 'titles'
    ) as { id: number }
    child.emit('message', {
      type: 'result',
      id: titleRequest.id,
      operation: 'titles',
      value: { titles: [] }
    })
    await expect(second).resolves.toEqual({ titles: [] })
    const disposing = client.dispose()
    child.emit('exit', 0)
    await disposing
  })

  it('restarts queued work after a sidecar crash with bounded backoff', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children)
    const first = client.listSessions({})
    const second = client.listSessions({ limit: 5 })
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()

    children[0]!.emit('exit', 1)
    await expect(first).rejects.toThrow('exited')
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(children).toHaveLength(2)
    readyAiVaultServiceChild(children[1]!)
    await Promise.resolve()
    children[1]!.emit('message', {
      type: 'result',
      id: relayRequestId(children[1]!, 'list'),
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await expect(second).resolves.toMatchObject({ sessions: [] })
    const disposing = client.dispose()
    children[1]!.emit('exit', 0)
    await disposing
  })

  it('retires the sidecar after the idle bound', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = createClient(children, 100)
    const list = client.listSessions({})
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const request = child.sent.find(
      (message) => (message as { operation?: string }).operation === 'list'
    ) as { id: number }
    child.emit('message', {
      type: 'result',
      id: request.id,
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-08-09T00:00:00.000Z' }
    })
    await list

    vi.advanceTimersByTime(99)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(1)
    expect(child.sent).toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(2_000)
    expect(child.killed).toBe(true)
    await client.dispose()
  })

  it('resolves the sidecar beside each bundled relay', () => {
    expect(relayAiVaultServiceEntryPath('/opt/orca/relay')).toBe(
      '/opt/orca/relay/relay-ai-vault-service.js'
    )
  })
})
