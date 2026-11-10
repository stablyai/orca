import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationMailboxPointerMessage } from './mailbox/terminal-pointer/mailbox-pointer-delivery-contract'
import { stageOrchestrationMailboxPointer } from './mailbox/terminal-pointer/mailbox-pointer-stage'
import type { OrchestrationMailboxTerminal } from './mailbox/routing/mailbox-owner'

const terminal: OrchestrationMailboxTerminal = {
  ptyId: 'pty-1',
  handle: 'term-1',
  paneKeys: ['tab-1:pane:1'],
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true
}

describe('mailbox pointer stage write failures (#11279)', () => {
  it('settles the flight when writePty throws synchronously', () => {
    const settle = vi.fn()
    const beginFlight = vi.fn(() => ({ enterTimer: null, stagedMessageIds: [] }))
    const isCurrentFlight = vi.fn(() => true)

    const message: OrchestrationMailboxPointerMessage = {
      id: 'm1',
      type: 'task_result',
      sequence: 1
    }
    stageOrchestrationMailboxPointer({
      deps: {
        resolveSubmitTarget: () => ({
          terminal,
          processIncarnation: 'inc-1'
        }),
        getDb: () => ({
          stageMailboxPointerEnter: () => true,
          markMailboxPointerWriteAttempted: () => true,
          areUnreadMessages: () => true
        }),
        getMessageWaiters: () => undefined,
        getCliCommand: () => 'orca',
        writePty: () => {
          throw new Error('write failed')
        }
      } as never,
      state: {
        beginFlight,
        isCurrentFlight,
        setWatermark: vi.fn(),
        deactivateWatermark: vi.fn()
      } as never,
      terminal,
      mailboxHandle: 'run:run_1',
      messages: [message],
      newestSequence: 1,
      enterDelayMs: 500,
      settle,
      redrive: vi.fn()
    })

    expect(beginFlight).toHaveBeenCalledWith('pty-1')
    expect(settle).toHaveBeenCalled()
  })
})
