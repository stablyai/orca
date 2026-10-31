import { describe, expect, it, vi } from 'vitest'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

const leaf: OrchestrationMailboxLeaf = {
  tabId: 'tab-1',
  leafId: 'pane:1',
  ptyId: 'pty-1',
  writable: true,
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true,
  lastOscTitle: null
}

describe('mailbox pointer submit typing quiet (#14832)', () => {
  it('skips delayed Enter when this PTY had user input in the last 5s and the window is focused', async () => {
    const writePty = vi.fn()
    const settle = vi.fn()
    const redrive = vi.fn()
    const scheduleTypingQuietRetry = vi.fn()
    const deactivateWatermark = vi.fn(() => true)
    const markAsUndelivered = vi.fn()
    const target = {
      leaf,
      terminalHandle: 'term-1',
      processIncarnation: 'inc-1'
    }

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => 'run:run_1' } as never,
        state: {
          isCurrentFlight: () => true,
          clearWatermark: vi.fn(),
          deactivateWatermark
        } as never,
        getDb: () =>
          ({
            markAsUndelivered,
            areUnreadMessages: () => true
          }) as never,
        resolveSubmitTarget: () => target,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        lastUserInputAt: () => 9_200,
        isOrcaWindowFocused: () => true,
        now: () => 10_000,
        scheduleTypingQuietRetry,
        settle,
        redrive
      },
      {
        leaf,
        mailboxHandle: 'run:run_1',
        messages: [{ id: 'm1', type: 'task_result' }],
        newestSequence: 1,
        ptyId: 'pty-1',
        flight: { enterTimer: null, stagedMessageIds: [] } as never,
        expectedTarget: target
      }
    )

    await vi.waitFor(() => {
      expect(settle).toHaveBeenCalled()
    })

    expect(writePty).not.toHaveBeenCalled()
    expect(markAsUndelivered).not.toHaveBeenCalled()
    expect(deactivateWatermark).toHaveBeenCalled()
    expect(scheduleTypingQuietRetry).toHaveBeenCalledWith('pty-1', 'run:run_1')
  })
})
