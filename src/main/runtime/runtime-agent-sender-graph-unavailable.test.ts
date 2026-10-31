import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'pty-local-1'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

it('keeps a running terminal’s sender row, by its start-time handle, while no window graph exists', () => {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    getForegroundProcess: async () => null
  })
  // The handle the terminal's agent is started with, which its mail cards save as the sender.
  const handle = runtime.preAllocateHandleForPty(PTY_ID)
  runtime.registerPty(PTY_ID, WORKTREE_ID, 'target', {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'inc-1'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
    ]
  })
  const { senders } = runtime['agentProjections']
  const row = { identity: handle, paneKey: `${TAB_ID}:${LEAF_ID}`, worktreeId: WORKTREE_ID }
  expect(senders.build().associations).toContainEqual(row)

  // The window closes: the host drops its leaves and handle records, and keeps start-time handles.
  runtime.markGraphUnavailable(1)
  const records = new Map(runtime['handles'])
  expect(senders.build().associations).toContainEqual(row)
  // Reading the handle issued nothing.
  expect(runtime['handles']).toEqual(records)
})
