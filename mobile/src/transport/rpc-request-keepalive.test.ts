import { afterEach, expect, it, vi } from 'vitest'
import { directWire, directWireTracker } from './direct-rpc-wire-test-harness'
import { rpcRequestKeepaliveId } from './rpc-request-keepalive'

afterEach(() => vi.useRealTimers())

it.each([
  ['its own', true, 2500],
  ['another request’s', false, 1000]
] as const)(
  'times a direct request by %s keepalives, never past its total allowance',
  async (_case, own, expiresAt) => {
    vi.useFakeTimers()
    const socket = directWire()
    const tracker = directWireTracker(socket)
    const start = Date.now()
    let settledAt: number | null = null
    void tracker
      .sendRequest('agent.launch', {}, { timeoutMs: 1000, keepaliveTotalMs: 2500 })
      .catch(() => (settledAt = Date.now() - start))
    await vi.advanceTimersByTimeAsync(0)
    const [{ id }] = socket.frames() as [{ id: string }]
    for (let beat = 0; beat < 2; beat += 1) {
      await vi.advanceTimersByTimeAsync(900)
      const frame = { _keepalive: true, requestId: own ? id : 'rpc-other' }
      tracker.keepalive(rpcRequestKeepaliveId(frame)!)
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(settledAt).toBe(expiresAt)
  }
)
