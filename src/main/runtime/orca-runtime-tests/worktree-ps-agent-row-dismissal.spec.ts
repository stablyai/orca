import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { makeAgentStatusStoreWiring } from '../agent-status-store-wiring.test-fixture'

/**
 * One store means one dismissal. Before PR 1b the runtime kept its own copy of the OSC row, so a
 * row the user dismissed on the desktop stayed in `orca worktree ps` and on the phone until the
 * PTY exited. These drive the real OSC byte path so the producer under test is the runtime's own
 * parse, not a hand-built snapshot.
 */
const LEAF_ID = '77777777-7777-4777-8777-777777777777'
const PANE_KEY = `tab-dismiss:${LEAF_ID}`

function wiredRuntime(): {
  runtime: OrcaRuntimeService
  statusWiring: ReturnType<typeof makeAgentStatusStoreWiring>
} {
  const statusWiring = makeAgentStatusStoreWiring()
  const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-dismiss',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Codex',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-dismiss',
        worktreeId: TEST_WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'dismiss-pty'
      }
    ]
  })
  return { runtime, statusWiring }
}

function emitWorkingStatus(runtime: OrcaRuntimeService, sequence: number): void {
  runtime.onPtyData(
    'dismiss-pty',
    '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07',
    sequence
  )
}

describe('worktree ps follows a dismissal out of the agent-status store', () => {
  it('drops the row as soon as the user dismisses it, without waiting for the PTY to exit', async () => {
    const { runtime, statusWiring } = wiredRuntime()
    emitWorkingStatus(runtime, 1)

    const listed = await runtime.getWorktreePs()
    expect(
      listed.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.agents
    ).toEqual([expect.objectContaining({ paneKey: PANE_KEY, prompt: 'ship it' })])

    statusWiring.statusStore.dropStatusEntry(PANE_KEY)

    // The PTY is untouched and still connected; only the store was told.
    expect(runtime['ptysById'].get('dismiss-pty')?.connected).toBe(true)
    const afterDismissal = await runtime.getWorktreePs()
    expect(
      afterDismissal.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.agents
    ).toEqual([])
  })

  it('tells paired clients to republish on the transition and on the dismissal', async () => {
    const { runtime, statusWiring } = wiredRuntime()
    const republish = vi.spyOn(runtime, 'touchMobileSessionTabsForPane')
    const uninstall = statusWiring.attach(runtime)
    try {
      emitWorkingStatus(runtime, 1)
      expect(republish).toHaveBeenCalledWith(PANE_KEY, TEST_WORKTREE_ID)

      // The same payload again changes nothing a client would render.
      republish.mockClear()
      emitWorkingStatus(runtime, 2)
      expect(republish).not.toHaveBeenCalled()

      runtime.onPtyData(
        'dismiss-pty',
        '\x1b]9999;{"state":"done","prompt":"ship it","agentType":"codex"}\x07',
        3
      )
      expect(republish).toHaveBeenCalledWith(PANE_KEY, TEST_WORKTREE_ID)

      republish.mockClear()
      statusWiring.statusStore.dropStatusEntry(PANE_KEY)
      expect(republish).toHaveBeenCalledWith(PANE_KEY)
    } finally {
      uninstall()
      republish.mockRestore()
    }
  })
})
