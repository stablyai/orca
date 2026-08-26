import { describe, expect, it, vi } from 'vitest'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
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

describe('mailbox pointer stage write failures (#11279)', () => {
  it('settles the flight when writePty throws synchronously', () => {
    const settle = vi.fn()
    const beginFlight = vi.fn(() => ({ enterTimer: null, stagedMessageIds: [] }))
    const isCurrentFlight = vi.fn(() => true)

    stageOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => 'run:run_1' } as never,
        state: {
          beginFlight,
          isCurrentFlight
        } as never,
        getDb: () => null,
        getLeaf: () => leaf,
        getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
        getMessageWaiters: () => undefined,
        getTabTitle: () => 'Claude',
        isLeafPtyProvenAbsent: async () => false,
        writePty: () => {
          throw new Error('write failed')
        },
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle: 'run:run_1',
        unread: [{ id: 'm1', type: 'task_result', sequence: 1 }],
        newestSequence: 1
      }
    )

    expect(beginFlight).toHaveBeenCalledWith('pty-1')
    expect(settle).toHaveBeenCalled()
  })
})
