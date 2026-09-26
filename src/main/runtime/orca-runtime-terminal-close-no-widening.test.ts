import { describe, expect, it } from 'vitest'
import {
  LEAF_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  createHarness,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'

const emptyLayout = { root: null, activeLeafId: null, expandedLeafId: null }

/**
 * Every explicit close of one pane, from every entry point, under every condition that has ever
 * widened one into a whole-tab close: the live sibling survives and no tab-level close goes out.
 */

type Entry = 'renderer' | 'cli-graph' | 'cli-pty' | 'phone-desktop' | 'phone-headless'
type Condition =
  | 'normal'
  | 'stop-unconfirmed'
  | 'stop-throws'
  | 'leaf-already-retired'
  | 'unbound-sibling'
  | 'pinned'
  | 'no-saved-layout'
  | 'no-live-pty'
  | 'kill-fails'
  | 'nothing-published'

/** The desktop renderer's split tab as it publishes it, with the given PTY bindings. */
function syncRendererSplit(
  harness: CloseContinuityHarness,
  ptyIdsByLeafId: Record<string, string>,
  livePtyIdsByLeafId = ptyIdsByLeafId
): void {
  const parentLayout = {
    root: {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, leafId: LEAF_ID },
      second: { type: 'leaf' as const, leafId: SIBLING_LEAF_ID }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
  const leaves = [LEAF_ID, SIBLING_LEAF_ID].map((leafId, index) => ({
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    leafId,
    paneRuntimeId: 7 + index,
    ptyId: livePtyIdsByLeafId[leafId] ?? null
  }))
  harness.runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Fixture shell',
        activeLeafId: LEAF_ID,
        layout: parentLayout.root
      }
    ],
    leaves,
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'renderer:unbound-pane',
        snapshotVersion: 3,
        activeGroupId: null,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal' as const,
        tabs: leaves.map((leaf) => ({
          type: 'terminal' as const,
          id: `${TAB_ID}::${leaf.leafId}`,
          parentTabId: TAB_ID,
          leafId: leaf.leafId,
          ...(ptyIdsByLeafId[leaf.leafId] ? { ptyId: ptyIdsByLeafId[leaf.leafId] } : {}),
          title: 'Fixture shell',
          parentLayout,
          isActive: leaf.leafId === LEAF_ID
        }))
      }
    ]
  })
}

function arrange(entry: Entry, condition: Condition): CloseContinuityHarness {
  const usesPtyRecord = entry !== 'cli-graph' && entry !== 'renderer' && condition !== 'no-live-pty'
  const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: usesPtyRecord })
  if (condition === 'unbound-sibling') {
    // A pane the renderer just split: no PTY bound yet, so main's saved layout lacks it.
    syncRendererSplit(harness, { [LEAF_ID]: PTY_ID })
  } else {
    harness.syncSplitFixtureGraph()
  }
  if (condition === 'no-live-pty') {
    // The closed pane's process already exited, so main holds no record of its PTY.
    syncRendererSplit(
      harness,
      { [LEAF_ID]: 'pty-exited', [SIBLING_LEAF_ID]: SIBLING_PTY_ID },
      { [SIBLING_LEAF_ID]: SIBLING_PTY_ID }
    )
  }
  if (entry === 'cli-pty') {
    // Graph without the leaf: the handle resolves through the PTY, as for a runtime-owned pane.
    harness.syncFixtureTabWithoutLeaf()
  }
  if (condition === 'nothing-published') {
    // The renderer lists the tab before its panes register and before it publishes any row.
    harness.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: null,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:nothing-published',
          snapshotVersion: 4,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
  }
  if (condition === 'kill-fails') {
    harness.kill.mockReturnValue(false)
  }
  if (condition === 'stop-unconfirmed') {
    harness.setVerifiedStopResult(false)
  } else if (condition === 'stop-throws') {
    harness.setVerifiedStopResult(new Error('ssh_host_unreachable'))
  } else {
    harness.setVerifiedStopResult(true)
  }
  if (condition === 'leaf-already-retired') {
    harness.editSession((session) =>
      retireTerminalSurfaceFromPersistence(session, {
        worktreeId: WORKTREE_ID,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID
      })
    )
  } else if (condition === 'pinned') {
    harness.editSession((session) => ({
      ...session,
      tabsByWorktree: {
        [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => ({
          ...tab,
          isPinned: true
        }))
      }
    }))
  } else if (condition === 'no-saved-layout') {
    harness.editSession((session) => ({ ...session, terminalLayoutsByTabId: {} }))
  }
  // A renderer that honours a whole-tab close, so a widened close shows as the lost sibling.
  harness.setCloseTerminalTabAction(() => harness.retirePersistedTab())
  return harness
}

async function closePane(entry: Entry, harness: CloseContinuityHarness): Promise<void> {
  if (entry === 'renderer') {
    harness.runtime.closeTerminalSurfaceFromRenderer(WORKTREE_ID, {
      kind: 'pane',
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    return
  }
  if (entry === 'cli-graph' || entry === 'cli-pty') {
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )
    if (!terminal) {
      throw new Error('fixture pane has no terminal handle')
    }
    await harness.runtime.closeTerminal(terminal.handle)
    return
  }
  if (entry === 'phone-headless') {
    harness.runtime.setNotifier(null)
    harness.syncEmptyGraph()
  }
  await harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_ID}`, {
    reason: 'user'
  })
}

const rows: [Entry, Condition][] = [
  // e.g. the exited-pane overlay's Close after main's exit handling retired that pane (fc5cac5c32).
  ['renderer', 'leaf-already-retired'],
  ['renderer', 'unbound-sibling'],
  ['renderer', 'pinned'],
  ['renderer', 'no-saved-layout'],
  ['cli-graph', 'normal'],
  ['cli-graph', 'stop-unconfirmed'],
  ['cli-graph', 'leaf-already-retired'],
  ['cli-graph', 'unbound-sibling'],
  ['cli-pty', 'normal'],
  // An unconfirmed stop once chose the tab close (bc8bbd7abf).
  ['cli-pty', 'stop-unconfirmed'],
  ['cli-pty', 'stop-throws'],
  ['cli-pty', 'unbound-sibling'],
  // An owner copy with no panes once read as "one pane", so the close took the whole tab.
  ['cli-pty', 'nothing-published'],
  ['phone-desktop', 'normal'],
  ['phone-desktop', 'pinned'],
  ['phone-desktop', 'unbound-sibling'],
  ['phone-desktop', 'no-saved-layout'],
  // A pane with no live process record once sent a tab-level close notice.
  ['phone-desktop', 'no-live-pty'],
  ['phone-desktop', 'kill-fails'],
  // A host with no desktop window once closed the whole tab for one pane.
  ['phone-headless', 'normal'],
  ['phone-headless', 'kill-fails'],
  ['phone-headless', 'leaf-already-retired'],
  ['phone-headless', 'pinned'],
  ['phone-headless', 'no-saved-layout']
]

describe('an explicit close of one pane never widens into its tab', () => {
  it.each(rows)('%s close, %s', async (entry, condition) => {
    const harness = arrange(entry, condition)
    const siblingWasPersisted = Boolean(
      harness.getSession().terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[SIBLING_LEAF_ID]
    )

    await closePane(entry, harness)

    const session = harness.getSession()
    expect(session.tabsByWorktree[WORKTREE_ID]).toEqual([expect.objectContaining({ id: TAB_ID })])
    if (siblingWasPersisted) {
      expect(session.terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
        type: 'leaf',
        leafId: SIBLING_LEAF_ID
      })
    }
    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalledWith(SIBLING_PTY_ID)
    if (entry === 'renderer') {
      return
    }
    if (entry === 'phone-headless') {
      const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(snapshot.tabs.map((tab) => tab.id)).toEqual([`${TAB_ID}::${SIBLING_LEAF_ID}`])
      expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
      return
    }
    expect(harness.closeTerminalPane).toHaveBeenCalledExactlyOnceWith(TAB_ID, LEAF_ID)
  })
})

describe("a close of a tab's last pane still closes the tab", () => {
  it('on a host with no desktop window, closes the whole tab in main and for paired clients', async () => {
    const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
    harness.runtime.setNotifier(null)
    harness.syncEmptyGraph()

    await harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_ID}`, {
      reason: 'user'
    })

    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect((await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([])
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })

  it.each([
    ['no saved layout', () => ({})],
    ['a layout saved before its pane mounted', () => ({ [TAB_ID]: emptyLayout })]
  ] as const)(
    'on a host with no desktop window, closes an unsplit tab with %s',
    async (_name, layouts) => {
      const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
      harness.runtime.setNotifier(null)
      harness.syncEmptyGraph()
      harness.editSession((session) => ({ ...session, terminalLayoutsByTabId: layouts() }))

      await harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, `${TAB_ID}::${LEAF_ID}`, {
        reason: 'user'
      })

      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
    }
  )

  it('from the CLI by PTY, closes an unsplit tab whose renderer graph lists no panes yet', async () => {
    const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
    harness.syncFixtureTabWithoutLeaf()
    harness.setVerifiedStopResult(true)
    harness.setCloseTerminalTabAction(() => harness.retirePersistedTab())

    await closePane('cli-pty', harness)

    expect(harness.closeTerminalTab.mock.calls.map((call) => call[0])).toEqual([TAB_ID])
    expect(harness.closeTerminalPane).not.toHaveBeenCalled()
  })

  it.each(['phone-desktop', 'cli-graph'] as const)(
    'from %s, goes through the renderer tab close so its pin guard still runs',
    async (entry) => {
      const harness = createHarness({
        publishMobileSurface: true,
        registerPtyBacked: entry === 'phone-desktop'
      })
      harness.setVerifiedStopResult(true)
      harness.setCloseTerminalTabAction(() => harness.retirePersistedTab())

      await closePane(entry, harness)

      expect(harness.closeTerminalTab.mock.calls.map((call) => call[0])).toEqual([TAB_ID])
      expect(harness.closeTerminalPane).not.toHaveBeenCalled()
    }
  )
})
