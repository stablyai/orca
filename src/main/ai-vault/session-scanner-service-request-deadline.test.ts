import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS } from './session-scanner-service-client-state'
import { AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS } from './session-scanner-service-request-deadline'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

const SCAN = { type: 'request', operation: 'scan', options: {} } as const
const SCAN_VALUE = { result: { sessions: [], issues: [], scannedAt: '2026-10-12' }, durationMs: 1 }
const WORK = { stage: 'finding', agents: [], read: { done: 0, total: 0 } } as const

function setup(): { children: AiVaultServiceTestChild[]; client: AiVaultScannerServiceClient } {
  const children: AiVaultServiceTestChild[] = []
  const client = new AiVaultScannerServiceClient({
    processFactory: () => {
      const child = new AiVaultServiceTestChild(12_345 + children.length)
      children.push(child)
      return child.asChildProcess()
    },
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  return { children, client }
}

async function startScan(
  client: AiVaultScannerServiceClient,
  children: AiVaultServiceTestChild[],
  signal?: AbortSignal
): Promise<{ scan: Promise<unknown>; child: AiVaultServiceTestChild; id: number }> {
  const scan = client.request(SCAN, signal)
  const child = children.at(-1)!
  readyAiVaultServiceChild(child)
  await Promise.resolve()
  return { scan, child, id: aiVaultServiceRequestId(child, 'scan') }
}

function progress(child: AiVaultServiceTestChild, id: number): void {
  child.emit('message', { type: 'progress', id, work: WORK })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AI Vault service request deadlines', () => {
  it('lets a scan run as long as it needs, even with no progress', async () => {
    const { children, client } = setup()
    const { scan, child, id } = await startScan(client, children)

    vi.advanceTimersByTime(60 * 60_000)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    child.emit('message', { type: 'result', id, operation: 'scan', value: SCAN_VALUE })

    await expect(scan).resolves.toEqual(SCAN_VALUE)
    expect(child.killed).toBe(false)
    client.dispose()
  })

  it('forwards only its own scan work to the scan listener', async () => {
    const { children, client } = setup()
    const work = vi.fn()
    const scan = client.request(SCAN, undefined, { work })
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const id = aiVaultServiceRequestId(child, 'scan')

    progress(child, id + 100)
    progress(child, id)

    expect(work).toHaveBeenCalledExactlyOnceWith(WORK)
    child.emit('message', { type: 'result', id, operation: 'scan', value: SCAN_VALUE })
    await expect(scan).resolves.toEqual(SCAN_VALUE)
    client.dispose()
  })

  it('retires a stalled interactive call with shutdown first after its fixed bound', async () => {
    const { children, client } = setup()
    const subagents = client.request({
      type: 'request',
      operation: 'subagents',
      request: { agent: 'claude', parentFilePath: '/tmp/parent.jsonl' }
    })
    const child = children[0]!
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const rejected = expect(subagents).rejects.toThrow(
      `AI Vault service timed out after ${AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS}ms.`
    )

    vi.advanceTimersByTime(AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS - 1)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(1)

    await rejected
    expect(child.sent).toContainEqual({ type: 'shutdown' })
    expect(child.killed).toBe(false)
    vi.advanceTimersByTime(AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS)
    expect(child.killed).toBe(true)
    client.dispose()
  })

  it('kills a child that does not acknowledge a cancelled scan', async () => {
    const { children, client } = setup()
    const controller = new AbortController()
    const { scan, child, id } = await startScan(client, children, controller.signal)

    controller.abort()
    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).toContainEqual({ type: 'cancel', id })
    vi.advanceTimersByTime(AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS - 1)
    progress(child, id)
    expect(child.killed).toBe(false)
    vi.advanceTimersByTime(1)

    expect(child.killed).toBe(true)
    client.dispose()
  })

  it('kills a child at once on a malformed progress frame', async () => {
    const { children, client } = setup()
    const { scan, child, id } = await startScan(client, children)
    const rejected = expect(scan).rejects.toThrow('malformed')

    child.emit('message', { type: 'progress', id })

    await rejected
    expect(child.killed).toBe(true)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })
    client.dispose()
  })
})
