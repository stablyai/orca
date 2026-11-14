import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultRowDelivery } from '../../ipc/ai-vault-row-delivery'
import { AiVaultScanCoordinator } from '../scan-lifecycle/ai-vault-scan-coordinator'
import { forwardRowInterest, rowsAreObserved } from '../scan-lifecycle/ai-vault-row-interest'
import { listResult } from '../structured-sessions/structured-session-ownership.test-support'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'
import { TestChild } from './session-scanner-service-child.test-fixture'
const EMPTY = { sessions: [], issues: [], scannedAt: '2026-11-13' }
afterEach(() => vi.useRealTimers())
it('withdraws a timed-out delivery through nested coordinators and service while another owner survives', async () => {
  vi.useFakeTimers()
  const child = new TestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChild(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn((_channel: string, event: { requestToken: string; sequence: number }) => {
      if (event.requestToken === 'keep') {
        keep.ack(event.sequence)
      }
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery uses only these EventEmitter, send and destruction methods.
  const web = sender as unknown as WebContents
  const delivery = new AiVaultRowDelivery(web, 'retire')
  const keep = new AiVaultRowDelivery(web, 'keep')
  const outer = new AiVaultScanCoordinator()
  const inner = new AiVaultScanCoordinator()
  const innerStart: Parameters<typeof inner.run>[0]['start'] = async (signal, _id, rows) => {
    const result = await client.request<{ result: typeof EMPTY }>(
      { type: 'request', operation: 'scan', options: {} },
      signal,
      { work: () => undefined, rows }
    )
    return result.result
  }
  const outerStart: Parameters<typeof outer.run>[0]['start'] = (signal, _id, publish) => {
    const observe = (rows: Parameters<typeof delivery.observe>[0]) =>
      publish(rows.kind === 'delta' ? rows.delta : { upserts: [...rows.sessions], removed: [] })
    forwardRowInterest(observe, publish)
    return inner.run({ key: 'local', signal, observeRows: observe, start: innerStart })
  }
  try {
    const first = outer.run({ key: 'outer', observeRows: delivery.observe, start: outerStart })
    const second = outer.run({ key: 'outer', observeRows: keep.observe, start: outerStart })
    await vi.advanceTimersByTimeAsync(0)
    child.emit('message', { type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const id = child.sent.find((entry) => entry.type === 'request')?.id
    const delta = { upserts: listResult().sessions, removed: [] }
    child.emit('message', { type: 'rows', id, delta })
    await vi.advanceTimersByTimeAsync(5250)
    expect(rowsAreObserved(delivery.observe)).toBe(false)
    expect(rowsAreObserved(keep.observe)).toBe(true)
    expect(child.sent.filter((entry) => entry.type === 'rowsInterest')).toHaveLength(0)
    keep.dispose()
    expect(child.sent.at(-1)).toMatchObject({ type: 'rowsInterest', observed: false })
    const sends = sender.send.mock.calls.length
    for (let i = 0; i < 1000; i++) {
      child.emit('message', { type: 'rows', id, delta })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender.send).toHaveBeenCalledTimes(sends)
    child.emit('message', {
      type: 'result',
      id,
      operation: 'scan',
      value: { result: EMPTY, durationMs: 1, work: null }
    })
    await expect(Promise.all([first, second])).resolves.toEqual([EMPTY, EMPTY])
  } finally {
    delivery.dispose()
    keep.dispose()
    client.dispose()
  }
})
