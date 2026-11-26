import { describe, expect, it, vi } from 'vitest'
import { PiRpcDialogCallbacks } from './rpc-dialog-callbacks'

describe('Pi goal reports', () => {
  it('journals bounded goal transitions and ignores unrelated decorations', () => {
    const apply = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    const dialogs = new PiRpcDialogCallbacks(
      { apply, isRequestRow: vi.fn() },
      send,
      vi.fn(),
      null,
      vi.fn()
    )
    const goal = {
      objective: 'Verify the change',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 120,
      timeUsedSeconds: 2,
      createdAt: 1000,
      updatedAt: 3000
    }
    const report = (value: unknown, statusKey = 'orca-pi-thread-goal-v1') =>
      dialogs.receive({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey,
        statusText: JSON.stringify(value)
      })
    report({ state: 'set', goal }, 'unrelated')
    report({ state: 'set', goal: { ...goal, tokensUsed: -1 } })
    expect(apply).not.toHaveBeenCalled()

    report({ state: 'set', goal })
    report({ state: 'set', goal })
    report({ state: 'cleared' })

    expect(apply.mock.calls).toEqual([
      [
        [
          {
            type: 'item.close',
            item: 'pi-thread-goal:1',
            body: {
              kind: 'status',
              presentation: 'thread-goal',
              text: 'Verify the change',
              threadGoal: { state: 'set', goal }
            }
          }
        ]
      ],
      [
        [
          {
            type: 'item.close',
            item: 'pi-thread-goal:2',
            body: {
              kind: 'status',
              presentation: 'thread-goal',
              text: '',
              threadGoal: { state: 'cleared' }
            }
          }
        ]
      ]
    ])
    expect(send).not.toHaveBeenCalled()
  })
})
