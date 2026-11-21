import { normalizeGitGraphFilters } from '../../../shared/git/history/git-graph-filters'
import { normalizePersonalProjectOrder } from '../../../shared/personal-project-order'
import { normalizeExplorerDisplayRootByWorktree } from '../../../shared/file-listing/file-explorer-display-root'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { getDefaultUIState } from '../../../shared/orca-profiles/constants'
import { normalizeAgentActivityDisplayMode } from '../../../shared/agent-status/presentation/agent-activity-display-mode'
import { normalizeWorktreeCardProperties } from '../../../shared/worktree/row-display/card-properties'
import {
  normalizeWorkspaceStatuses,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity
} from '../../../shared/workspace/status/workspace-statuses'
import { normalizeUsagePercentageDisplay } from '../../../shared/agent-usage/display/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../shared/status-bar/status-bar-usage-mode'
import { normalizeStatusBarUsageFormat } from '../../../shared/status-bar/status-bar-usage-format'
import { clampMarkdownTocPanelWidth } from '../../../shared/editor/markdown/markdown-toc-panel-width'
import { normalizeSidebarBotsHeight } from '../../../shared/sidebar-bots-height'
import { clampCombinedDiffFileTreeWidth } from '../../../shared/source-control/diff/combined-diff-file-tree-width'
import {
  normalizeVisibleExecutionHostIds,
  normalizeExecutionHostOrder
} from '../../../shared/execution-host/execution-host'
import { normalizeManualRepoOrder } from '../../../shared/repository/manual-repo-order'
import { normalizeBrowserPageZoomLevel } from '../../../shared/browser/site-settings/browser-page-zoom'
import { normalizeFeatureTipIds } from '../../../shared/feature-education/feature-tips'
import { normalizeContextualTourIds } from '../../../shared/feature-education/contextual-tours/contextual-tours'
import { normalizeFeatureInteractions } from '../../../shared/feature-education/interactions/feature-interactions'
import {
  normalizeGroupBy,
  normalizeProjectOrderBy,
  normalizeNotificationsMutedByWorktree,
  normalizeRightSidebarExplorerView,
  normalizeRightSidebarTab,
  normalizeShowDotfilesByWorktree,
  normalizeSortBy
} from './ui-selection-normalization'
import { stripMainOwnedTelemetryMarkerFromUI } from './ui-interaction-merge'

export function getPersistedUI(
  state: PersistedState,
  activeView: PersistedState['ui']['activeView']
): PersistedState['ui'] {
  const uiState = stripMainOwnedTelemetryMarkerFromUI(state.ui)
  return {
    ...getDefaultUIState(),
    ...uiState,
    groupBy: normalizeGroupBy(state.ui?.groupBy),
    sortBy: normalizeSortBy(state.ui?.sortBy),
    personalProjectOrder: normalizePersonalProjectOrder(state.ui?.personalProjectOrder),
    projectOrderBy: normalizeProjectOrderBy(state.ui?.projectOrderBy),
    rightSidebarTab: normalizeRightSidebarTab(state.ui?.rightSidebarTab),
    rightSidebarExplorerView: normalizeRightSidebarExplorerView(
      state.ui?.rightSidebarExplorerView,
      state.ui?.rightSidebarTab
    ),
    worktreeCardProperties: normalizeWorktreeCardProperties(state.ui?.worktreeCardProperties),
    showAgentModels: state.ui?.showAgentModels !== false,
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(state.ui?.agentActivityDisplayMode),
    workspaceStatuses: normalizeWorkspaceStatuses(state.ui?.workspaceStatuses),
    workspaceBoardOpacity: clampWorkspaceBoardOpacity(state.ui?.workspaceBoardOpacity),
    workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(state.ui?.workspaceBoardColumnWidth),
    sidebarBotsHeight: normalizeSidebarBotsHeight(state.ui?.sidebarBotsHeight) ?? undefined,
    sidebarProjectsFirst: state.ui?.sidebarProjectsFirst === true,
    syncTaskStatusFromWorkspaceBoard: state.ui?.syncTaskStatusFromWorkspaceBoard === true,
    usagePercentageDisplay: normalizeUsagePercentageDisplay(state.ui?.usagePercentageDisplay),
    statusBarUsageMode: normalizeStatusBarUsageMode(state.ui?.statusBarUsageMode),
    statusBarUsageFormat: normalizeStatusBarUsageFormat(state.ui?.statusBarUsageFormat),
    statusBarCompactChangeNoticeDismissed:
      state.ui?.statusBarCompactChangeNoticeDismissed !== false,
    trayMinimizeNoticeShown: state.ui?.trayMinimizeNoticeShown === true,
    osc52ClipboardDefaultOnNoticePending: state.ui?.osc52ClipboardDefaultOnNoticePending === true,
    markdownTocPanelWidth: clampMarkdownTocPanelWidth(state.ui?.markdownTocPanelWidth),
    combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(state.ui?.combinedDiffFileTreeWidth),
    visibleWorkspaceHostIds: normalizeVisibleExecutionHostIds(state.ui?.visibleWorkspaceHostIds),
    agentsVisibleHostIds: normalizeVisibleExecutionHostIds(state.ui?.agentsVisibleHostIds),
    workspaceHostOrder: normalizeExecutionHostOrder(state.ui?.workspaceHostOrder),
    manualRepoOrder: normalizeManualRepoOrder(state.ui?.manualRepoOrder),
    browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(state.ui?.browserDefaultZoomLevel),
    explorerDisplayRootByWorktree: normalizeExplorerDisplayRootByWorktree(
      state.ui?.explorerDisplayRootByWorktree
    ),
    gitGraphFiltersByWorktree: normalizeGitGraphFilters(state.ui?.gitGraphFiltersByWorktree),
    showDotfilesByWorktree: normalizeShowDotfilesByWorktree(state.ui?.showDotfilesByWorktree),
    notificationsMutedByWorktree: normalizeNotificationsMutedByWorktree(
      state.ui?.notificationsMutedByWorktree
    ),
    featureTipsSeenIds: normalizeFeatureTipIds(state.ui?.featureTipsSeenIds),
    contextualToursSeenIds: normalizeContextualTourIds(state.ui?.contextualToursSeenIds),
    featureInteractions: normalizeFeatureInteractions(state.ui?.featureInteractions),
    activeView: activeView
  }
}
