import { describe, expect, it, vi } from 'vitest'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'

describe('OrchestrationMailboxDeliveryTarget absence probe', () => {
  it('redelivers every mailbox that deferred on one probe of a shared PTY', async () => {
    vi.useFakeTimers()
    let answer: (absent: boolean) => void = () => {}
    const target = new OrchestrationMailboxDeliveryTarget({
      getDb: () => null,
      getMailboxTerminalForPaneKey: () => null,
      getTerminalForHandle: () => null,
      hasTerminalHandle: () => true,
      isStructuredSessionOwner: () => false,
      canProbePtyLiveness: () => true,
      controllerKnowsPtyIsLive: () => false,
      isLeafPtyProvenAbsent: () => new Promise((resolve) => (answer = resolve))
    })
    const redeliver = vi.fn()

    expect(target.deferForAbsenceProbe('pty-coordinator', 'run:run_a', false, redeliver)).toBe(true)
    expect(target.deferForAbsenceProbe('pty-coordinator', 'run:run_b', false, redeliver)).toBe(true)
    answer(false)
    await vi.runAllTimersAsync()

    expect(redeliver.mock.calls.map(([mailbox]) => mailbox)).toEqual(['run:run_a', 'run:run_b'])
    vi.useRealTimers()
  })
})
