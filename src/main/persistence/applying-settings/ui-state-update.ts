import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getDefaultUIState,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../shared/constants'
import {
  normalizeWorkspaceStatuses,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity
} from '../../../shared/workspace-statuses'
import { normalizeUsagePercentageDisplay } from '../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../shared/status-bar-usage-mode'
import { clampMarkdownTocPanelWidth } from '../../../shared/markdown-toc-panel-width'
import { clampCombinedDiffFileTreeWidth } from '../../../shared/combined-diff-file-tree-width'
import {
  normalizeVisibleExecutionHostIds,
  normalizeExecutionHostOrder
} from '../../../shared/execution-host'
import { normalizeManualRepoOrder } from '../../../shared/manual-repo-order'
import { normalizeBrowserPageZoomLevel } from '../../../shared/browser-page-zoom'
import { normalizeFeatureTipIds } from '../../../shared/feature-tips'
import { normalizeContextualTourIds } from '../../../shared/contextual-tours'
import { normalizeFeatureInteractions } from '../../../shared/feature-interactions'
import { mergeWorkspaceCleanupUIState } from '../../../shared/workspace-cleanup-ui-state'
import { persistedUIValuesEqual } from '../../../shared/persisted-ui-equality'
import {
  PROTECTED_SECRET_SLOT,
  type ProtectedSecretPersistence
} from '../../protected-secret-persistence'
import {
  normalizeGroupBy,
  normalizeProjectOrderBy,
  normalizeRightSidebarExplorerView,
  normalizeRightSidebarTab,
  normalizeShowDotfilesByWorktree,
  normalizeSortBy
} from './ui-selection-normalization'
import {
  mergeContextualTourSeenIds,
  mergeFeatureInteractions,
  stripMainOwnedTelemetryMarkerFromUI
} from './ui-interaction-merge'

export type UIUpdateOperations = {
  state: PersistedState
  removeRetainedBlob: (
    slot: Parameters<ProtectedSecretPersistence['removeRetainedBlob']>[0]
  ) => void
  setActiveView: (activeView: PersistedState['ui']['activeView'] | undefined) => boolean
  getUI: () => PersistedState['ui']
  scheduleSave: () => void
  notifyUIChanged: () => void
}

export function updatePersistedUI(
  operations: UIUpdateOperations,
  updates: Partial<PersistedState['ui']>
): void {
  if ('browserKagiSessionLink' in updates && !updates.browserKagiSessionLink) {
    operations.removeRetainedBlob(PROTECTED_SECRET_SLOT.browserKagiSessionLink)
  }
  const sanitizedUpdates = stripMainOwnedTelemetryMarkerFromUI(updates)
  const { activeView, ...durableUpdates } = sanitizedUpdates
  const activeViewChanged = operations.setActiveView(activeView)
  if (Object.keys(durableUpdates).length === 0) {
    if (activeViewChanged) {
      operations.notifyUIChanged()
    }
    return
  }
  const currentUI = {
    ...getDefaultUIState(),
    ...stripMainOwnedTelemetryMarkerFromUI(operations.state.ui)
  }
  const previousUI = {
    ...operations.getUI(),
    // Why: the legacy field stays unchanged as a migration/downgrade
    // fallback; the profile sidecar is authoritative in current builds.
    activeView: currentUI.activeView
  }
  const nextRightSidebarTab =
    sanitizedUpdates.rightSidebarTab !== undefined
      ? normalizeRightSidebarTab(sanitizedUpdates.rightSidebarTab)
      : normalizeRightSidebarTab(operations.state.ui?.rightSidebarTab)
  const nextRightSidebarExplorerView =
    sanitizedUpdates.rightSidebarExplorerView !== undefined
      ? normalizeRightSidebarExplorerView(
          sanitizedUpdates.rightSidebarExplorerView,
          nextRightSidebarTab
        )
      : sanitizedUpdates.rightSidebarTab === 'search'
        ? 'search'
        : normalizeRightSidebarExplorerView(
            operations.state.ui?.rightSidebarExplorerView,
            nextRightSidebarTab
          )
  const nextUI = {
    ...currentUI,
    ...durableUpdates,
    workspaceCleanup: mergeWorkspaceCleanupUIState(
      currentUI.workspaceCleanup,
      durableUpdates.workspaceCleanup
    ),
    groupBy: durableUpdates.groupBy
      ? normalizeGroupBy(durableUpdates.groupBy)
      : normalizeGroupBy(operations.state.ui?.groupBy),
    sortBy: durableUpdates.sortBy
      ? normalizeSortBy(durableUpdates.sortBy)
      : normalizeSortBy(operations.state.ui?.sortBy),
    projectOrderBy: sanitizedUpdates.projectOrderBy
      ? normalizeProjectOrderBy(sanitizedUpdates.projectOrderBy)
      : normalizeProjectOrderBy(operations.state.ui?.projectOrderBy),
    activeView: currentUI.activeView,
    rightSidebarTab: nextRightSidebarTab,
    rightSidebarExplorerView: nextRightSidebarExplorerView,
    worktreeCardProperties:
      sanitizedUpdates.worktreeCardProperties !== undefined
        ? normalizeWorktreeCardProperties(sanitizedUpdates.worktreeCardProperties)
        : normalizeWorktreeCardProperties(operations.state.ui?.worktreeCardProperties),
    agentActivityDisplayMode:
      sanitizedUpdates.agentActivityDisplayMode !== undefined
        ? normalizeAgentActivityDisplayMode(sanitizedUpdates.agentActivityDisplayMode)
        : normalizeAgentActivityDisplayMode(operations.state.ui?.agentActivityDisplayMode),
    workspaceStatuses:
      sanitizedUpdates.workspaceStatuses !== undefined
        ? normalizeWorkspaceStatuses(sanitizedUpdates.workspaceStatuses)
        : normalizeWorkspaceStatuses(operations.state.ui?.workspaceStatuses),
    workspaceBoardOpacity: clampWorkspaceBoardOpacity(
      sanitizedUpdates.workspaceBoardOpacity ?? operations.state.ui?.workspaceBoardOpacity
    ),
    workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(
      sanitizedUpdates.workspaceBoardColumnWidth ?? operations.state.ui?.workspaceBoardColumnWidth
    ),
    syncTaskStatusFromWorkspaceBoard:
      sanitizedUpdates.syncTaskStatusFromWorkspaceBoard !== undefined
        ? sanitizedUpdates.syncTaskStatusFromWorkspaceBoard === true
        : operations.state.ui?.syncTaskStatusFromWorkspaceBoard === true,
    usagePercentageDisplay: normalizeUsagePercentageDisplay(
      sanitizedUpdates.usagePercentageDisplay ?? operations.state.ui?.usagePercentageDisplay
    ),
    statusBarUsageMode: normalizeStatusBarUsageMode(
      sanitizedUpdates.statusBarUsageMode ?? operations.state.ui?.statusBarUsageMode
    ),
    markdownTocPanelWidth: clampMarkdownTocPanelWidth(
      sanitizedUpdates.markdownTocPanelWidth ?? operations.state.ui?.markdownTocPanelWidth
    ),
    combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(
      sanitizedUpdates.combinedDiffFileTreeWidth ?? operations.state.ui?.combinedDiffFileTreeWidth
    ),
    visibleWorkspaceHostIds:
      sanitizedUpdates.visibleWorkspaceHostIds !== undefined
        ? normalizeVisibleExecutionHostIds(sanitizedUpdates.visibleWorkspaceHostIds)
        : normalizeVisibleExecutionHostIds(operations.state.ui?.visibleWorkspaceHostIds),
    agentsVisibleHostIds:
      sanitizedUpdates.agentsVisibleHostIds !== undefined
        ? normalizeVisibleExecutionHostIds(sanitizedUpdates.agentsVisibleHostIds)
        : normalizeVisibleExecutionHostIds(operations.state.ui?.agentsVisibleHostIds),
    workspaceHostOrder:
      sanitizedUpdates.workspaceHostOrder !== undefined
        ? normalizeExecutionHostOrder(sanitizedUpdates.workspaceHostOrder)
        : normalizeExecutionHostOrder(operations.state.ui?.workspaceHostOrder),
    manualRepoOrder:
      sanitizedUpdates.manualRepoOrder !== undefined
        ? normalizeManualRepoOrder(sanitizedUpdates.manualRepoOrder)
        : normalizeManualRepoOrder(operations.state.ui?.manualRepoOrder),
    browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(
      sanitizedUpdates.browserDefaultZoomLevel ?? operations.state.ui?.browserDefaultZoomLevel
    ),
    showDotfilesByWorktree:
      sanitizedUpdates.showDotfilesByWorktree !== undefined
        ? normalizeShowDotfilesByWorktree(sanitizedUpdates.showDotfilesByWorktree)
        : normalizeShowDotfilesByWorktree(operations.state.ui?.showDotfilesByWorktree),
    featureTipsSeenIds:
      sanitizedUpdates.featureTipsSeenIds !== undefined
        ? normalizeFeatureTipIds(sanitizedUpdates.featureTipsSeenIds)
        : normalizeFeatureTipIds(operations.state.ui?.featureTipsSeenIds),
    // Why: renderer and paired clients can mark different tours seen from stale snapshots; union so completed tours stay suppressed.
    contextualToursSeenIds:
      sanitizedUpdates.contextualToursSeenIds !== undefined
        ? mergeContextualTourSeenIds(
            operations.state.ui?.contextualToursSeenIds,
            sanitizedUpdates.contextualToursSeenIds
          )
        : normalizeContextualTourIds(operations.state.ui?.contextualToursSeenIds),
    // Why: runtime RPCs and the renderer both record education state; merge so a stale renderer snapshot can't erase runtime-only interactions.
    featureInteractions:
      sanitizedUpdates.featureInteractions !== undefined
        ? mergeFeatureInteractions(
            operations.state.ui?.featureInteractions,
            sanitizedUpdates.featureInteractions
          )
        : normalizeFeatureInteractions(operations.state.ui?.featureInteractions)
  }
  if (persistedUIValuesEqual(previousUI, nextUI)) {
    if (activeViewChanged) {
      operations.notifyUIChanged()
    }
    return
  }
  operations.state.ui = nextUI
  operations.scheduleSave()
  operations.notifyUIChanged()
}
