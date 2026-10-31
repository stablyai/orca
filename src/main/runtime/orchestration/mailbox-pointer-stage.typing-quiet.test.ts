import { describe, expect, it, vi } from 'vitest'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type { OrchestrationMailboxPointerMessage } from './mailbox-pointer-delivery-contract'

const leaf: OrchestrationMailboxLeaf = {
  tabId: 'tab-1',
  leafId: 'pane:1',
  ptyId: 'pty-1',
  writable: true,
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true,
  lastOscTitle: null
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
          leaf,
          terminalHandle: 'term-1',
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
      leaf,
      mailboxHandle: 'run:run_1',
      messages: [message],
      newestSequence: 1,
      enterDelayMs: 500,
      leafKey: 'tab-1:pane:1',
      settle,
      redrive: vi.fn()
    })

    expect(beginFlight).toHaveBeenCalledWith('pty-1')
    expect(settle).toHaveBeenCalled()
  })
})
