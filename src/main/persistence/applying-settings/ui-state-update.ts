import { normalizePersonalProjectOrder } from '../../../shared/personal-project-order'
import { normalizeExplorerDisplayRootByWorktree } from '../../../shared/file-explorer-display-root'
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
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  normalizeExecutionHostOrder
} from '../../../shared/execution-host'
import { workspaceHostScopeForVisibleHosts } from '../../../shared/workspace-view/workspace-host-visibility'
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
  mergeFeatureTipSeenIds,
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
  const clearsProtectedSecret =
    'browserKagiSessionLink' in updates && !updates.browserKagiSessionLink
  if (clearsProtectedSecret) {
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
    // Keep the legacy activeView for downgrade compatibility; the profile sidecar is authoritative.
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
  const nextVisibleWorkspaceHostIds = normalizeVisibleExecutionHostIds(
    sanitizedUpdates.visibleWorkspaceHostIds !== undefined
      ? sanitizedUpdates.visibleWorkspaceHostIds
      : operations.state.ui?.visibleWorkspaceHostIds
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
    personalProjectOrder: normalizePersonalProjectOrder(
      durableUpdates.personalProjectOrder ?? currentUI.personalProjectOrder
    ),
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
    visibleWorkspaceHostIds: nextVisibleWorkspaceHostIds,
    // Paired clients may write only visible hosts; derive scope so all-hosts cannot override them.
    ...(sanitizedUpdates.visibleWorkspaceHostIds !== undefined &&
    sanitizedUpdates.workspaceHostScope === undefined
      ? {
          workspaceHostScope: workspaceHostScopeForVisibleHosts(
            nextVisibleWorkspaceHostIds,
            normalizeExecutionHostScope(currentUI.workspaceHostScope)
          )
        }
      : {}),
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
    explorerDisplayRootByWorktree:
      sanitizedUpdates.explorerDisplayRootByWorktree !== undefined
        ? normalizeExplorerDisplayRootByWorktree(sanitizedUpdates.explorerDisplayRootByWorktree)
        : normalizeExplorerDisplayRootByWorktree(
            operations.state.ui?.explorerDisplayRootByWorktree
          ),
    showDotfilesByWorktree:
      sanitizedUpdates.showDotfilesByWorktree !== undefined
        ? normalizeShowDotfilesByWorktree(sanitizedUpdates.showDotfilesByWorktree)
        : normalizeShowDotfilesByWorktree(operations.state.ui?.showDotfilesByWorktree),
    // Union dismissals so stale clients cannot revive one-time tips.
    featureTipsSeenIds:
      sanitizedUpdates.featureTipsSeenIds !== undefined
        ? mergeFeatureTipSeenIds(
            operations.state.ui?.featureTipsSeenIds,
            sanitizedUpdates.featureTipsSeenIds
          )
        : normalizeFeatureTipIds(operations.state.ui?.featureTipsSeenIds),
    // Union seen tours across stale renderer and paired-client snapshots.
    contextualToursSeenIds:
      sanitizedUpdates.contextualToursSeenIds !== undefined
        ? mergeContextualTourSeenIds(
            operations.state.ui?.contextualToursSeenIds,
            sanitizedUpdates.contextualToursSeenIds
          )
        : normalizeContextualTourIds(operations.state.ui?.contextualToursSeenIds),
    // Merge runtime interactions so stale renderer saves cannot erase them.
    featureInteractions:
      sanitizedUpdates.featureInteractions !== undefined
        ? mergeFeatureInteractions(
            operations.state.ui?.featureInteractions,
            sanitizedUpdates.featureInteractions
          )
        : normalizeFeatureInteractions(operations.state.ui?.featureInteractions)
  }
  // A sealed secret looks empty in memory; an explicit clear must still reach disk.
  if (!clearsProtectedSecret && persistedUIValuesEqual(previousUI, nextUI)) {
    if (activeViewChanged) {
      operations.notifyUIChanged()
    }
    return
  }
  operations.state.ui = nextUI
  operations.scheduleSave()
  operations.notifyUIChanged()
}
