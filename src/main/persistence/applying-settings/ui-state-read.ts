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
import {
  normalizeGroupBy,
  normalizeProjectOrderBy,
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
    projectOrderBy: normalizeProjectOrderBy(state.ui?.projectOrderBy),
    rightSidebarTab: normalizeRightSidebarTab(state.ui?.rightSidebarTab),
    rightSidebarExplorerView: normalizeRightSidebarExplorerView(
      state.ui?.rightSidebarExplorerView,
      state.ui?.rightSidebarTab
    ),
    worktreeCardProperties: normalizeWorktreeCardProperties(state.ui?.worktreeCardProperties),
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(state.ui?.agentActivityDisplayMode),
    workspaceStatuses: normalizeWorkspaceStatuses(state.ui?.workspaceStatuses),
    workspaceBoardOpacity: clampWorkspaceBoardOpacity(state.ui?.workspaceBoardOpacity),
    workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(state.ui?.workspaceBoardColumnWidth),
    syncTaskStatusFromWorkspaceBoard: state.ui?.syncTaskStatusFromWorkspaceBoard === true,
    usagePercentageDisplay: normalizeUsagePercentageDisplay(state.ui?.usagePercentageDisplay),
    statusBarUsageMode: normalizeStatusBarUsageMode(state.ui?.statusBarUsageMode),
    // Why: strict boolean coercion so a missing/legacy value reads as false (first-run notice still fires).
    trayMinimizeNoticeShown: state.ui?.trayMinimizeNoticeShown === true,
    osc52ClipboardDefaultOnNoticePending: state.ui?.osc52ClipboardDefaultOnNoticePending === true,
    markdownTocPanelWidth: clampMarkdownTocPanelWidth(state.ui?.markdownTocPanelWidth),
    combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(state.ui?.combinedDiffFileTreeWidth),
    visibleWorkspaceHostIds: normalizeVisibleExecutionHostIds(state.ui?.visibleWorkspaceHostIds),
    workspaceHostOrder: normalizeExecutionHostOrder(state.ui?.workspaceHostOrder),
    manualRepoOrder: normalizeManualRepoOrder(state.ui?.manualRepoOrder),
    browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(state.ui?.browserDefaultZoomLevel),
    showDotfilesByWorktree: normalizeShowDotfilesByWorktree(state.ui?.showDotfilesByWorktree),
    featureTipsSeenIds: normalizeFeatureTipIds(state.ui?.featureTipsSeenIds),
    contextualToursSeenIds: normalizeContextualTourIds(state.ui?.contextualToursSeenIds),
    featureInteractions: normalizeFeatureInteractions(state.ui?.featureInteractions),
    activeView: activeView
  }
}
