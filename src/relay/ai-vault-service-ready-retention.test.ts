import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import {
  AiVaultServiceTestChild,
  readyAiVaultServiceChild
} from '../main/ai-vault/session-scanner-service-test-child'
import type { AiVaultSessionTitleRequest } from '../shared/ai-vault-session-title'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'

function fixture() {
  const child = new AiVaultServiceTestChild()
  const processFactory = vi.fn(() => child.asChildProcess())
  const client = new RelayAiVaultServiceClient({
    processFactory,
    init: { remoteHome: '/home/ada', hostPlatform: getRemoteHostPlatform('linux-x64') }
  })
  return { client, child, processFactory }
}

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This regression requires --expose-gc')
  }
  for (let turn = 0; turn < 3; turn++) {
    await setImmediate()
    global.gc()
  }
}

function titleRequests(): AiVaultSessionTitleRequest[] {
  return [{ agent: 'claude', sessionId: 'session', transcriptPath: '/home/ada/session.jsonl' }]
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('AI Vault readiness ownership', () => {
  it('releases canceled request payloads while readiness remains pending', async () => {
    const { client, child, processFactory } = fixture()
    const canceled = await (async () => {
      const refs: WeakRef<AiVaultSessionTitleRequest[]>[] = []
      for (let index = 0; index < 1000; index++) {
        const requests = titleRequests()
        refs.push(new WeakRef(requests))
        const controller = new AbortController()
        const result = client.resolveSessionTitles(requests, controller.signal)
        controller.abort()
        const error = await result.catch((reason: unknown) => reason)
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          throw new Error('Canceled title request did not reject with AbortError')
        }
      }
      return refs
    })()
    await collect()
    expect(canceled.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
    expect(child.sent).toHaveLength(1)
    expect(processFactory).toHaveBeenCalledOnce()

    const live = client.resolveSessionTitles(titleRequests())
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    expect(child.sent.at(-1)).toMatchObject({ type: 'request', id: 1001, operation: 'titles' })
    child.emit('message', { type: 'result', id: 1001, operation: 'titles', value: { titles: [] } })
    await expect(live).resolves.toEqual({ titles: [] })
    const disposed = client.dispose()
    child.emit('exit', 0)
    await disposed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases uncanceled readiness payloads when the client is disposed', async () => {
    const { client, child } = fixture()
    const discarded = await (async () => {
      const requests = titleRequests()
      const ref = new WeakRef(requests)
      const result = client.resolveSessionTitles(requests)
      const rejection = expect(result).rejects.toThrow('disposed')
      const disposed = client.dispose()
      child.emit('exit', 0)
      await disposed
      await rejection
      return ref
    })()
    await collect()
    expect(discarded.deref() === undefined).toBe(true)
    expect(child.sent).toEqual([expect.objectContaining({ type: 'init' }), { type: 'shutdown' }])
    expect(vi.getTimerCount()).toBe(0)
    await expect(client.resolveSessionTitles([])).rejects.toThrow('disposed')
  })

  it('does not send a call canceled in the turn that readiness arrives', async () => {
    const { client, child } = fixture()
    const controller = new AbortController()
    const canceled = client.resolveSessionTitles(titleRequests(), controller.signal)
    readyAiVaultServiceChild(child)
    controller.abort()
    const live = client.resolveSessionTitles([])
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).toEqual([
      expect.objectContaining({ type: 'init' }),
      { type: 'request', id: 2, operation: 'titles', requests: [] }
    ])
    child.emit('message', { type: 'result', id: 2, operation: 'titles', value: { titles: [] } })
    await expect(live).resolves.toEqual({ titles: [] })
    const disposed = client.dispose()
    child.emit('exit', 0)
    await disposed
  })
})

it('retries an unsent lane after spawn fails while the other lane starts a child', async () => {
  const child = new AiVaultServiceTestChild()
  const processFactory = vi.fn(() => child.asChildProcess())
  processFactory.mockImplementationOnce(() => {
    throw new Error('temporary spawn failure')
  })
  const client = new RelayAiVaultServiceClient({
    processFactory,
    init: { remoteHome: '/home/ada', hostPlatform: getRemoteHostPlatform('linux-x64') }
  })
  const list = client.listSessions({})
  const titles = client.resolveSessionTitles([])
  void list.catch(() => undefined)
  void titles.catch(() => undefined)
  try {
    readyAiVaultServiceChild(child)
    await vi.waitFor(() => {
      expect(child.sent).toContainEqual({ type: 'request', id: 1, operation: 'list', params: {} })
    })
    expect(processFactory).toHaveBeenCalledTimes(2)
    expect(child.sent).toContainEqual({ type: 'request', id: 1, operation: 'list', params: {} })
    expect(child.sent).toContainEqual({ type: 'request', id: 2, operation: 'titles', requests: [] })
    child.emit('message', {
      type: 'result',
      id: 1,
      operation: 'list',
      value: { sessions: [], issues: [], scannedAt: '2026-09-25T00:00:00.000Z' }
    })
    child.emit('message', { type: 'result', id: 2, operation: 'titles', value: { titles: [] } })
    await expect(list).resolves.toMatchObject({ sessions: [] })
    await expect(titles).resolves.toEqual({ titles: [] })
  } finally {
    const disposed = client.dispose()
    child.emit('exit', 0)
    await disposed
  }
})
