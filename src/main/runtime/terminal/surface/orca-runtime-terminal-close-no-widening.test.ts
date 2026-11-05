import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  LEAF_ID,
  INCARNATION_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { createHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { expectDesktopDropsPane } from '../../__fixtures__/main-layout-close-fixture'
import type { CloseContinuityHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'

/** All explicit pane-close paths must retain live siblings and send no tab-level close. */

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
  | 'pane-unlisted'

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
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    harness.editSession((session) => ({
      ...session,
      terminalLayoutsByTabId: { ...session.terminalLayoutsByTabId, [TAB_ID]: parentLayout }
    }))
  }
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
    // Renderer split exists before PTY binding/persistence.
    syncRendererSplit(harness, { [LEAF_ID]: PTY_ID })
  } else {
    harness.syncSplitFixtureGraph()
  }
  if (condition === 'no-live-pty') {
    syncRendererSplit(
      harness,
      { [LEAF_ID]: 'pty-exited', [SIBLING_LEAF_ID]: SIBLING_PTY_ID },
      { [SIBLING_LEAF_ID]: SIBLING_PTY_ID }
    )
  }
  if (entry === 'cli-pty') {
    // Graphless leaf resolves through the PTY, matching runtime-owned panes.
    harness.syncFixtureTabWithoutLeaf()
  }
  if (condition === 'nothing-published') {
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
  if (condition === 'pane-unlisted') {
    // Renderer lags main: sibling has no layout, closed pane has no row.
    harness.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: SIBLING_LEAF_ID,
          layout: { type: 'leaf' as const, leafId: SIBLING_LEAF_ID }
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:pane-unlisted',
          snapshotVersion: 4,
          activeGroupId: null,
          activeTabId: `${TAB_ID}::${SIBLING_LEAF_ID}`,
          activeTabType: 'terminal' as const,
          tabs: [
            {
              type: 'terminal' as const,
              id: `${TAB_ID}::${SIBLING_LEAF_ID}`,
              parentTabId: TAB_ID,
              leafId: SIBLING_LEAF_ID,
              ptyId: SIBLING_PTY_ID,
              title: 'Fixture shell',
              isActive: true
            }
          ]
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
  // Honor erroneous tab-close requests so widening actually destroys the sibling.
  harness.setCloseTerminalTabAction(() => harness.retirePersistedTab())
  return harness
}

async function closePane(entry: Entry, harness: CloseContinuityHarness): Promise<void> {
  if (entry === 'renderer') {
    await harness.runtime.closeTerminalSurfaceFromRenderer({
      worktreeId: WORKTREE_ID,
      target: {
        kind: 'pane',
        tabId: TAB_ID,
        leafId: LEAF_ID
      }
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
  // Exited-pane overlay can close after main already retired the leaf (fc5cac5c32).
  ['renderer', 'leaf-already-retired'],
  ['renderer', 'unbound-sibling'],
  ['renderer', 'pinned'],
  ['renderer', 'no-saved-layout'],
  ['cli-graph', 'normal'],
  ['cli-graph', 'stop-unconfirmed'],
  ['cli-graph', 'leaf-already-retired'],
  ['cli-graph', 'unbound-sibling'],
  ['cli-pty', 'normal'],
  // Unverified stops previously widened to tab close (bc8bbd7abf).
  ['cli-pty', 'stop-unconfirmed'],
  ['cli-pty', 'stop-throws'],
  ['cli-pty', 'unbound-sibling'],
  // Missing owner panes previously read as one pane and widened close.
  ['cli-pty', 'nothing-published'],
  ['cli-pty', 'pane-unlisted'],
  ['phone-desktop', 'normal'],
  ['phone-desktop', 'pinned'],
  ['phone-desktop', 'unbound-sibling'],
  ['phone-desktop', 'no-saved-layout'],
  ['phone-desktop', 'no-live-pty'],
  ['phone-desktop', 'kill-fails'],
  ['phone-headless', 'normal'],
  ['phone-headless', 'kill-fails'],
  ['phone-headless', 'leaf-already-retired'],
  ['phone-headless', 'pinned'],
  ['phone-headless', 'no-saved-layout']
]

describe('an explicit close of one pane never widens into its tab', () => {
  const pending = ([entry, condition]: (typeof rows)[number]) =>
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    entry === 'phone-headless' &&
    (condition === 'leaf-already-retired' || condition === 'no-saved-layout')
  it.each(rows.filter((row) => !pending(row)))('%s close, %s', closesOnlyThatPane)
})

async function closesOnlyThatPane(
  entry: (typeof rows)[number][0],
  condition: (typeof rows)[number][1]
): Promise<void> {
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
    expect(harness.stopAndWait).toHaveBeenCalledWith(
      PTY_ID,
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
    expect(harness.kill).not.toHaveBeenCalled()
    return
  }
  expectDesktopDropsPane(harness, TAB_ID, LEAF_ID)
}

/** Last-pane tab close uses legacy renderer acknowledgement or main-owned layout without renderer notice. */

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
    expect(harness.kill).toHaveBeenCalledWith(
      PTY_ID,
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
  })
})

it('leaves a terminal another tab already owns usable when the addressed tab closes', async () => {
  const f = createHarness({ registerPtyBacked: true })
  const otherTab = 'other-existing-owner'
  const otherLeaf = '30000000-0000-4000-8000-000000000003'
  const publish = (withClosing: boolean) => {
    const panes = [
      ...(withClosing ? [{ tabId: TAB_ID, leafId: LEAF_ID }] : []),
      { tabId: otherTab, leafId: otherLeaf }
    ]
    f.runtime.syncWindowGraph(1, {
      tabs: panes.map((pane) => ({
        tabId: pane.tabId,
        worktreeId: WORKTREE_ID,
        title: 'Shell',
        activeLeafId: pane.leafId,
        layout: { type: 'leaf', leafId: pane.leafId }
      })),
      leaves: panes.map((pane, index) => ({
        ...pane,
        worktreeId: WORKTREE_ID,
        paneRuntimeId: index + 10,
        ptyId: PTY_ID
      })),
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:shared-resource',
          snapshotVersion: withClosing ? 1 : 2,
          activeGroupId: null,
          activeTabId: `${otherTab}::${otherLeaf}`,
          activeTabType: 'terminal',
          tabs: panes.map((pane) => ({
            type: 'terminal',
            id: `${pane.tabId}::${pane.leafId}`,
            parentTabId: pane.tabId,
            leafId: pane.leafId,
            ptyId: PTY_ID,
            title: 'Shell',
            isActive: pane.tabId === otherTab
          }))
        }
      ]
    })
  }
  f.editSession((session) => ({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WORKTREE_ID]: [
        ...(session.tabsByWorktree[WORKTREE_ID] ?? []),
        { ...session.tabsByWorktree[WORKTREE_ID]![0]!, id: otherTab }
      ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [otherTab]: {
        root: { type: 'leaf', leafId: otherLeaf },
        activeLeafId: otherLeaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [otherLeaf]: PTY_ID }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      ...session.terminalPtyIncarnationsByPaneKey,
      [makePaneKey(otherTab, otherLeaf)]: INCARNATION_ID
    }
  }))
  publish(true)
  const closing = (await f.runtime.listTerminals()).terminals.find((row) => row.tabId === TAB_ID)!
  f.setCloseTerminalTabAction(() => publish(false))
  await f.runtime.closeTerminalTab(closing.handle)
  const survivor = (await f.runtime.listTerminals()).terminals.find(
    (row) => row.tabId === otherTab
  )!
  expect(await f.runtime.readTerminal(survivor.handle)).toMatchObject({ status: 'running' })
  expect(f.stopAndWait).not.toHaveBeenCalled()
  expect(f.kill).not.toHaveBeenCalled()
})
