import { describe, expect, it, vi } from 'vitest'
import { deleteAutomationRecordingCancelledWait, type WaitCancelRuntime } from './bot-wait-cancel'

function fakeRuntime(
  automation: ReturnType<WaitCancelRuntime['showAutomation']>,
  runs: ReturnType<WaitCancelRuntime['listAutomationRuns']> = []
) {
  const update = vi.fn(async () => ({}))
  const runtime: WaitCancelRuntime = {
    showAutomation: () => automation,
    listAutomationRuns: () => runs,
    deleteAutomation: async (id) => ({ removed: true, id }),
    bots: { update },
    inAutomationLane: (_id, operation) => operation()
  }
  return { runtime, update }
}

describe('deleteAutomationRecordingCancelledWait', () => {
  it("records a bot's wait that still waited as cancelled", async () => {
    const { runtime, update } = fakeRuntime({ once: { by: 9 }, bot: { botId: 'b1' } })
    await deleteAutomationRecordingCancelledWait(runtime, 'w1', undefined)
    expect(update).toHaveBeenCalledWith('b1', {
      cancelledWait: { automationId: 'w1', at: expect.any(Number) }
    })
  })

  it('records nothing for a wait whose run already started', async () => {
    const { runtime, update } = fakeRuntime({ once: { by: 9 }, bot: { botId: 'b1' } }, [
      { status: 'dispatched', trigger: 'event' }
    ])
    await deleteAutomationRecordingCancelledWait(runtime, 'w1', undefined)
    expect(update).not.toHaveBeenCalled()
  })

  it('records nothing for a routine', async () => {
    const { runtime, update } = fakeRuntime({ bot: { botId: 'b1' } })
    await deleteAutomationRecordingCancelledWait(runtime, 'r1', undefined)
    expect(update).not.toHaveBeenCalled()
  })
})
