import { describe, expect, it } from 'vitest'
import { sendStopCanTakeBack } from './structured-agent-session-unopened-send-withdrawal'
const sendBeforeStop = (overrides = {}) => ({
  dispatchState: 'pending' as const,
  handoverRecorded: true as const,
  handedOverAt: 5,
  ...overrides
})
describe('a send a Stop can take back', () => {
  it('is one still being handed over, or one this process lost the answer to', () => {
    expect(sendStopCanTakeBack(sendBeforeStop())).toBe(true)
    expect(sendStopCanTakeBack(sendBeforeStop({ dispatchState: 'unknown' }))).toBe(true)
  })

  // An earlier process's send: its child may have started it before the crash.
  it('is never one an earlier process left in doubt', () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ dispatchState: 'unknown', recovered: true }))).toBe(
      false
    )
  })

  // The card holds its text and returns paused; nothing was handed to the agent.
  it("is never a queued card's send that was not handed over", () => {
    expect(sendStopCanTakeBack(sendBeforeStop({ handedOverAt: undefined }))).toBe(false)
  })
})
