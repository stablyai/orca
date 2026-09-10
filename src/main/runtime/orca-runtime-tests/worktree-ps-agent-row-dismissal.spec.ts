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
const REMINTED_LEAF_ID = '88888888-8888-4888-8888-888888888888'
const PANE_KEY = `tab-dismiss:${LEAF_ID}`

function wiredRuntime(incarnationId?: string): {
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
  if (incarnationId) {
    runtime.registerPty('dismiss-pty', TEST_WORKTREE_ID, null, {
      tabId: 'tab-dismiss',
      leafId: LEAF_ID,
      incarnationId
    })
  }
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
    const republish = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')
    const uninstall = statusWiring.attach(runtime)
    try {
      emitWorkingStatus(runtime, 1)
      expect(republish).toHaveBeenCalledWith(TEST_WORKTREE_ID)

      // The same payload again changes nothing a client would render.
      republish.mockClear()
      emitWorkingStatus(runtime, 2)
      expect(republish).not.toHaveBeenCalled()

      runtime.onPtyData(
        'dismiss-pty',
        '\x1b]9999;{"state":"done","prompt":"ship it","agentType":"codex"}\x07',
        3
      )
      expect(republish).toHaveBeenCalledWith(TEST_WORKTREE_ID)

      republish.mockClear()
      statusWiring.statusStore.dropStatusEntry(PANE_KEY)
      expect(republish).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    } finally {
      uninstall()
      republish.mockRestore()
    }
  })

  it.each([
    ['leaf binding', undefined, false],
    ['controller incarnation', 'incarnation-1', true]
  ] as const)(
    'rejoins a row through its %s handle after pane ownership clears',
    async (_, incarnationId, clearLeafBinding) => {
      const { runtime, statusWiring } = wiredRuntime(incarnationId)
      emitWorkingStatus(runtime, 1)
      const row = statusWiring.statusStore.getStatusSnapshot()[0]!
      const internals = runtime as unknown as {
        handleByLeafKey: Map<string, string>
        handleByPtyIncarnation: Map<string, { handle: string }>
        ptysById: Map<string, { paneKey: string | null; tabId: string | null }>
      }
      const pty = internals.ptysById.get('dismiss-pty')!
      pty.paneKey = null
      pty.tabId = null
      if (clearLeafBinding) {
        expect(internals.handleByPtyIncarnation.get('dismiss-pty')?.handle).toBe(row.terminalHandle)
        internals.handleByLeafKey.clear()
      }

      const listed = await runtime.getWorktreePs()

      expect(
        listed.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.agents
      ).toEqual([expect.objectContaining({ prompt: 'ship it' })])
      statusWiring.statusStore.stop()
    }
  )

  it('publishes one provider-addressable row through remint, dismissal, and exit', async () => {
    const { runtime, statusWiring } = wiredRuntime('incarnation-1')
    emitWorkingStatus(runtime, 1)
    const row = statusWiring.statusStore.getStatusSnapshot()[0]!
    expect(row.terminalHandle).toMatch(/^term_/)
    statusWiring.statusStore.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-dismiss',
        worktreeId: TEST_WORKTREE_ID,
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      null
    )

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-reminted',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: REMINTED_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-reminted',
          worktreeId: TEST_WORKTREE_ID,
          leafId: REMINTED_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'dismiss-pty'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'reminted-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-reminted::${REMINTED_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-reminted::${REMINTED_LEAF_ID}`,
              parentTabId: 'tab-reminted',
              leafId: REMINTED_LEAF_ID,
              ptyId: 'dismiss-pty',
              title: 'Codex',
              isActive: true
            }
          ]
        }
      ]
    })

    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const events: Awaited<ReturnType<typeof runtime.listMobileSessionTabs>>[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const uninstall = statusWiring.attach(runtime)
    try {
      emitWorkingStatus(runtime, 2)
      await vi.waitFor(() => expect(events).toHaveLength(1))
      const remintedPaneKey = `tab-reminted:${REMINTED_LEAF_ID}`
      expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: remintedPaneKey,
          terminalHandle: row.terminalHandle,
          providerSession: { key: 'session_id', id: 'provider-session-1' }
        })
      ])
      expect(events[0]).toMatchObject({
        snapshotVersion: before.snapshotVersion + 1,
        tabs: [
          expect.objectContaining({
            agentStatus: expect.objectContaining({
              state: 'working',
              providerSession: { key: 'session_id', id: 'provider-session-1' }
            })
          })
        ]
      })

      statusWiring.statusStore.dropStatusEntry(remintedPaneKey)
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(events[1]).toMatchObject({
        snapshotVersion: before.snapshotVersion + 2,
        tabs: [expect.objectContaining({ agentStatus: expect.objectContaining({ state: 'done' }) })]
      })
      expect((await runtime.getWorktreePs()).worktrees[0]?.agents).toEqual([])

      runtime.onPtyExit('dismiss-pty', 0)
      await vi.waitFor(() => expect(events).toHaveLength(3))
      expect(events[2]).toMatchObject({ snapshotVersion: before.snapshotVersion + 4 })
      expect(
        events[2]?.tabs.every((tab) => tab.type !== 'terminal' || tab.agentStatus === undefined)
      ).toBe(true)
      expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    } finally {
      uninstall()
      unsubscribe()
      statusWiring.statusStore.stop()
    }
  })

  it('keeps runtime-owned legacy OSC rows in worktree.ps and mobile projections', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'legacy-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: 'pane:7',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'legacy-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:7',
          paneRuntimeId: 7,
          ptyId: 'legacy-pty'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'legacy-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'legacy-tab::pane:7',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'legacy-tab::pane:7',
              parentTabId: 'legacy-tab',
              leafId: 'pane:7',
              ptyId: 'legacy-pty',
              title: 'Codex',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData(
      'legacy-pty',
      '\x1b]9999;{"state":"working","prompt":"legacy task","agentType":"codex"}\x07',
      1
    )

    const listed = await runtime.getWorktreePs()
    const mobile = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(
      listed.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.agents
    ).toEqual([expect.objectContaining({ paneKey: 'legacy-tab:7', prompt: 'legacy task' })])
    expect(mobile.tabs[0]).toMatchObject({
      type: 'terminal',
      agentStatus: { paneKey: 'legacy-tab:7', prompt: 'legacy task' }
    })
    runtime.onPtyExit('legacy-pty', 0)
    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    statusWiring.statusStore.stop()
  })
})
