import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RpcSessionLivenessWatchdog,
  type RpcSessionIdentity
} from './rpc-session-liveness-watchdog'

describe('RpcSessionLivenessWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fixture() {
    const sendProbe = vi.fn((_identity: RpcSessionIdentity, _id: string) => true)
    const terminate = vi.fn()
    const watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe,
      terminate,
      now: Date.now
    })
    const identity = {}
    watchdog.start(identity)
    return { identity, sendProbe, terminate, watchdog }
  }

  it('does not reuse a probe id after the same identity starts a new generation', async () => {
    const { identity, sendProbe, terminate, watchdog } = fixture()
    watchdog.probeNow(identity, 4_000)
    const oldProbe = sendProbe.mock.calls.at(-1)![1]
    watchdog.start(identity)
    watchdog.probeNow(identity, 4_000)
    expect(sendProbe.mock.calls.at(-1)![1]).not.toBe(oldProbe)
    watchdog.noteProbeReply(identity, oldProbe)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(terminate).toHaveBeenCalledExactlyOnceWith(identity)
  })
})
