import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyRelayExitProofs } from './legacy-relay-bridge-timers'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waiting on a bridged pane’s exit proof', () => {
  it('settles every overlapping waiter on one exit', async () => {
    const proofs = new LegacyRelayExitProofs()
    const first = proofs.wait('pty', 5_000)
    const second = proofs.wait('pty', 5_000)
    proofs.observe('pty')
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('never lets an earlier waiter’s deadline drop a later one', async () => {
    const proofs = new LegacyRelayExitProofs()
    const stale = proofs.wait('pty', 1_000)
    await vi.advanceTimersByTimeAsync(500)
    const retry = proofs.wait('pty', 5_000)
    await vi.advanceTimersByTimeAsync(600)
    await expect(stale).resolves.toBe(false)
    proofs.observe('pty')
    await expect(retry).resolves.toBe(true)
  })

  it('answers false on dispose', async () => {
    const proofs = new LegacyRelayExitProofs()
    const waiting = proofs.wait('pty', 5_000)
    proofs.dispose()
    await expect(waiting).resolves.toBe(false)
  })
})
