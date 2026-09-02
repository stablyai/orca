import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  CANARY_LEAF_ID,
  CANARY_TAB_ID,
  LEAF_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID,
  canaryMobileTab,
  canarySyncedLeaf,
  canarySyncedTab
} from './orca-runtime-terminal-close-continuity-state-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'

export type CloseContinuityGraphOptions = {
  ptyId: string
  publishMobileSurface?: boolean
  includeCanary?: boolean
}

type CloseContinuityGraphFixtureArgs = CloseContinuityGraphOptions & {
  runtime: OrcaRuntimeService
  getSession: () => WorkspaceSessionState
  setSession: (session: WorkspaceSessionState) => void
  markSiblingPtyIncluded: () => void
}

export function createCloseContinuityGraphFixture({
  runtime,
  ptyId,
  publishMobileSurface,
  includeCanary,
  getSession,
  setSession,
  markSiblingPtyIncluded
}: CloseContinuityGraphFixtureArgs) {
  const syncFixtureGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        },
        ...(includeCanary ? [canarySyncedTab] : [])
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId
        },
        ...(includeCanary ? [canarySyncedLeaf] : [])
      ],
      ...(publishMobileSurface
        ? {
            mobileSessionTabs: [
              {
                worktree: WORKTREE_ID,
                publicationEpoch: 'renderer:close-continuity',
                snapshotVersion: 1,
                activeGroupId: null,
                activeTabId: `${TAB_ID}::${LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [
                  {
                    type: 'terminal' as const,
                    id: `${TAB_ID}::${LEAF_ID}`,
                    parentTabId: TAB_ID,
                    leafId: LEAF_ID,
                    ptyId,
                    title: 'Fixture shell',
                    isActive: true
                  },
                  ...(includeCanary ? [canaryMobileTab] : [])
                ]
              }
            ]
          }
        : {})
    })

  const syncCanaryGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [canarySyncedTab],
      leaves: [canarySyncedLeaf],
      ...(publishMobileSurface
        ? {
            mobileSessionTabs: [
              {
                worktree: WORKTREE_ID,
                publicationEpoch: 'renderer:close-continuity',
                snapshotVersion: 2,
                activeGroupId: null,
                activeTabId: `${CANARY_TAB_ID}::${CANARY_LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [{ ...canaryMobileTab, isActive: true }]
              }
            ]
          }
        : {})
    })

  const syncEmptyGraph = () => runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

  const syncFixtureTabWithoutLeaf = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        },
        ...(includeCanary ? [canarySyncedTab] : [])
      ],
      leaves: includeCanary ? [canarySyncedLeaf] : []
    })

  const syncSplitFixtureGraph = () => {
    markSiblingPtyIncluded()
    const splitLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: SIBLING_LEAF_ID }
      },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_ID]: ptyId,
        [SIBLING_LEAF_ID]: SIBLING_PTY_ID
      }
    }
    const session = getSession()
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [TAB_ID]: splitLayout
      },
      terminalPtyIncarnationsByPaneKey: {
        ...session.terminalPtyIncarnationsByPaneKey,
        [makePaneKey(TAB_ID, SIBLING_LEAF_ID)]: SIBLING_INCARNATION_ID
      }
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: splitLayout.root
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId
        },
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: SIBLING_LEAF_ID,
          paneRuntimeId: 8,
          ptyId: SIBLING_PTY_ID
        }
      ],
      ...(publishMobileSurface
        ? {
            mobileSessionTabs: [
              {
                worktree: WORKTREE_ID,
                publicationEpoch: 'renderer:close-continuity-split',
                snapshotVersion: 2,
                activeGroupId: null,
                activeTabId: `${TAB_ID}::${LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [
                  {
                    type: 'terminal' as const,
                    id: `${TAB_ID}::${LEAF_ID}`,
                    parentTabId: TAB_ID,
                    leafId: LEAF_ID,
                    ptyId,
                    title: 'Fixture shell',
                    parentLayout: splitLayout,
                    isActive: true
                  },
                  {
                    type: 'terminal' as const,
                    id: `${TAB_ID}::${SIBLING_LEAF_ID}`,
                    parentTabId: TAB_ID,
                    leafId: SIBLING_LEAF_ID,
                    ptyId: SIBLING_PTY_ID,
                    title: 'Fixture sibling shell',
                    parentLayout: splitLayout,
                    isActive: false
                  }
                ]
              }
            ]
          }
        : {})
    })
  }

  return {
    syncFixtureGraph,
    syncCanaryGraph,
    syncEmptyGraph,
    syncFixtureTabWithoutLeaf,
    syncSplitFixtureGraph
  }
}
