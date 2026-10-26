import { resolveStatusBarCompactChangeNoticeDismissed } from '../../../shared/status-bar-compact-change-notice'
import { migrateExplorerDisplayRoots } from '../../../shared/file-explorer-display-root'
import {
  getWorktreeCardModeProperties,
  isDefaultedCompactWorktreeCardProperties,
  normalizeWorktreeCardProperties
} from '../../../shared/constants'
import { isExistingPersistedProfile } from '../../../shared/project-order-manual-default-notice'
import { resolveUsagePercentageDisplayChangeNoticeDismissed } from '../../../shared/usage-percentage-display-change-notice'
import { normalizePersistedWorkspaceStatuses } from '../../../shared/workspace-statuses'
import {
  normalizeRightSidebarExplorerView,
  normalizeRightSidebarTab,
  normalizeShowDotfilesByWorktree,
  normalizeSortBy
} from '../applying-settings/ui-selection-normalization'
import { stripMainOwnedTelemetryMarkerFromUI } from '../applying-settings/ui-interaction-merge'
import {
  readDeprecatedExperimentFlag,
  resolveSetupGuideSidebarDismissedOnLoad
} from '../applying-settings/onboarding-normalization'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { OnboardingState } from '../../../shared/onboarding-state-types'

export function normalizeLoadedUiState(
  parsed: PersistedState,
  defaults: PersistedState,
  normalizedOnboarding: OnboardingState,
  loadedCompactWorktreeCards: boolean,
  osc52ClipboardNoticePending: boolean,
  markNeedsSave: () => void
): PersistedState['ui'] {
  const explorerDisplayRootByWorktree = migrateExplorerDisplayRoots(
    parsed.ui?.explorerDisplayRootByWorktree,
    parsed.ui?._explorerDisplayRootMigrated === true,
    parsed.worktreeMeta ?? {}
  )
  if (parsed.ui?._explorerDisplayRootMigrated !== true) {
    markNeedsSave()
  }
  const rawSort = parsed.ui?.sortBy
  const sort = normalizeSortBy(rawSort)
  const migrate = !parsed.ui?._sortBySmartMigrated && rawSort === 'recent'
  const rightSidebarOpen =
    typeof parsed.ui?.rightSidebarOpen === 'boolean'
      ? parsed.ui.rightSidebarOpen
      : typeof parsed.settings?.rightSidebarOpenByDefault === 'boolean'
        ? parsed.settings.rightSidebarOpenByDefault
        : defaults.ui.rightSidebarOpen
  if (typeof parsed.ui?.rightSidebarOpen !== 'boolean') {
    markNeedsSave()
  }
  const workspaceStatusesDefaultOrderMigrated =
    parsed.ui?._workspaceStatusesDefaultOrderMigrated === true
  // Repair only the exact former status order, once; preserve user reorders.
  const workspaceStatusesReorderedDefaultRepaired =
    parsed.ui?._workspaceStatusesReorderedDefaultRepaired === true
  // Preserve customized labels, colors, icons and ordering.
  const workspaceStatusesDefaultWorkflowMigrated =
    parsed.ui?._workspaceStatusesDefaultWorkflowMigrated === true
  // Separate the visual migration guard so later choices of legacy visuals survive.
  const workspaceStatusesDefaultVisualsMigrated =
    parsed.ui?._workspaceStatusesDefaultVisualsMigrated === true
  const workspaceStatuses = normalizePersistedWorkspaceStatuses(parsed.ui?.workspaceStatuses, {
    migrateDefaultWorkflowStatuses: !workspaceStatusesDefaultWorkflowMigrated,
    repairReorderedDefaultStatuses: !workspaceStatusesReorderedDefaultRepaired,
    migrateLegacyDefaultStatusVisuals: !workspaceStatusesDefaultVisualsMigrated
  })
  if (
    !workspaceStatusesDefaultOrderMigrated ||
    !workspaceStatusesReorderedDefaultRepaired ||
    !workspaceStatusesDefaultWorkflowMigrated ||
    !workspaceStatusesDefaultVisualsMigrated
  ) {
    markNeedsSave()
  }
  const rawCardProps = parsed.ui?.worktreeCardProperties
  const inlineAgentsMigrated = parsed.ui?._inlineAgentsDefaultedForAllUsers === true
  const expandedCardPropsMigrated = parsed.ui?._expandedWorktreeCardPropertiesDefaulted === true
  const jiraIssueCardPropDefaulted = parsed.ui?._jiraIssueWorktreeCardPropertyDefaulted === true
  const hostCardPropDefaulted = parsed.ui?._hostWorktreeCardPropertyDefaulted === true
  const hadExperimentOn = readDeprecatedExperimentFlag(parsed)
  const deliberateUncheck =
    hadExperimentOn && Array.isArray(rawCardProps) && !rawCardProps.includes('inline-agents')
  const needsInlineAgentsMigration =
    !inlineAgentsMigrated &&
    !deliberateUncheck &&
    Array.isArray(rawCardProps) &&
    !rawCardProps.includes('inline-agents')
  const needsLegacyDefaultedCompactMigration =
    loadedCompactWorktreeCards &&
    parsed.ui?._worktreeCardModeDefaulted === true &&
    isDefaultedCompactWorktreeCardProperties(rawCardProps)
  const migratedCardProps = (() => {
    if (!Array.isArray(rawCardProps)) {
      return undefined
    }
    if (needsLegacyDefaultedCompactMigration) {
      return getWorktreeCardModeProperties('Compact')
    }
    const candidate = needsInlineAgentsMigration
      ? [...rawCardProps, 'inline-agents' as const]
      : rawCardProps
    const expandedCandidate = (() => {
      if (expandedCardPropsMigrated) {
        return candidate
      }
      const next = [...candidate]
      // Preserve cards formerly coupled to issue visibility or always shown.
      if (candidate.includes('issue') && !candidate.includes('linear-issue')) {
        next.push('linear-issue' as const)
      }
      if (!candidate.includes('ports')) {
        next.push('ports' as const)
      }
      return next
    })()
    // Jira arrived after the expansion migration, so it needs a separate backfill guard.
    const jiraCandidate =
      jiraIssueCardPropDefaulted || expandedCandidate.includes('jira-issue')
        ? expandedCandidate
        : [...expandedCandidate, 'jira-issue' as const]
    // Preserve the formerly unconditional host pill once when making it configurable.
    const hostCandidate =
      hostCardPropDefaulted || jiraCandidate.includes('host')
        ? jiraCandidate
        : [...jiraCandidate, 'host' as const]
    const normalized = normalizeWorktreeCardProperties(hostCandidate)
    const changed =
      normalized.length !== rawCardProps.length ||
      normalized.some((property, index) => property !== rawCardProps[index])
    return changed ? normalized : undefined
  })()
  if (
    migratedCardProps !== undefined ||
    !inlineAgentsMigrated ||
    !expandedCardPropsMigrated ||
    !jiraIssueCardPropDefaulted ||
    !hostCardPropDefaulted
  ) {
    markNeedsSave()
  }
  const rawExplorerView = parsed.ui?.rightSidebarExplorerView
  const rightSidebarExplorerView = normalizeRightSidebarExplorerView(
    rawExplorerView,
    parsed.ui?.rightSidebarTab
  )
  // Persist raw legacy Search-view repair before defaults hide its original shape.
  if (
    rawExplorerView === undefined
      ? rightSidebarExplorerView !== defaults.ui.rightSidebarExplorerView
      : rawExplorerView !== rightSidebarExplorerView
  ) {
    markNeedsSave()
  }
  const setupGuideSidebarDismissed = resolveSetupGuideSidebarDismissedOnLoad(
    parsed.ui?.setupGuideSidebarDismissed,
    normalizedOnboarding
  )
  if (
    parsed.ui?.setupGuideSidebarDismissed !== setupGuideSidebarDismissed &&
    (setupGuideSidebarDismissed || parsed.ui?.setupGuideSidebarDismissed !== undefined)
  ) {
    markNeedsSave()
  }
  // Only upgraded profiles on the new default need the usage-display notice.
  const percentageNoticeDismissed = resolveUsagePercentageDisplayChangeNoticeDismissed({
    rawDismissed: parsed.ui?.usagePercentageDisplayChangeNoticeDismissed,
    rawUsagePercentageDisplay: parsed.ui?.usagePercentageDisplay,
    isExistingProfile: isExistingPersistedProfile({
      repoCount: parsed.repos?.length ?? 0,
      onboardingClosedAt: normalizedOnboarding.closedAt,
      ui: parsed.ui
    })
  })
  const statusBarCompactChangeNoticeDismissed = resolveStatusBarCompactChangeNoticeDismissed({
    rawDismissed: parsed.ui?.statusBarCompactChangeNoticeDismissed,
    rawUsageMode: parsed.ui?.statusBarUsageMode,
    isExistingProfile: isExistingPersistedProfile({
      repoCount: parsed.repos?.length ?? 0,
      onboardingClosedAt: normalizedOnboarding.closedAt,
      ui: parsed.ui
    })
  })
  if (parsed.ui?.statusBarCompactChangeNoticeDismissed !== statusBarCompactChangeNoticeDismissed) {
    markNeedsSave()
  }
  // Compact rollout notice supersedes the percentage notice.
  const usagePercentageDisplayChangeNoticeDismissed =
    percentageNoticeDismissed || !statusBarCompactChangeNoticeDismissed
  if (
    parsed.ui?.usagePercentageDisplayChangeNoticeDismissed !==
    usagePercentageDisplayChangeNoticeDismissed
  ) {
    markNeedsSave()
  }
  return {
    ...defaults.ui,
    worktreeCardProperties: getWorktreeCardModeProperties(
      loadedCompactWorktreeCards ? 'Compact' : 'Default'
    ),
    ...stripMainOwnedTelemetryMarkerFromUI(parsed.ui),
    // The retired Appearance setting seeds chrome only without an explicit preference.
    rightSidebarOpen,
    rightSidebarTab: normalizeRightSidebarTab(parsed.ui?.rightSidebarTab),
    rightSidebarExplorerView,
    setupGuideSidebarDismissed,
    usagePercentageDisplayChangeNoticeDismissed,
    statusBarCompactChangeNoticeDismissed,
    setupGuideBrowserMilestoneMigrated:
      typeof parsed.ui?.setupGuideBrowserMilestoneMigrated === 'boolean'
        ? parsed.ui.setupGuideBrowserMilestoneMigrated
        : false,
    setupGuideBrowserMilestoneLegacyComplete:
      parsed.ui?.setupGuideBrowserMilestoneLegacyComplete === true,
    // Persist pending notices before windows exist so a crash cannot discard them.
    osc52ClipboardDefaultOnNoticePending: osc52ClipboardNoticePending,
    sortBy: migrate ? ('smart' as const) : sort,
    _explorerDisplayRootMigrated: true,
    explorerDisplayRootByWorktree,
    showDotfilesByWorktree: normalizeShowDotfilesByWorktree(parsed.ui?.showDotfilesByWorktree),
    workspaceStatuses,
    _workspaceStatusesDefaultOrderMigrated: true,
    _workspaceStatusesReorderedDefaultRepaired: true,
    _workspaceStatusesDefaultWorkflowMigrated: true,
    _workspaceStatusesDefaultVisualsMigrated: true,
    _sortBySmartMigrated: true,
    ...(migratedCardProps !== undefined ? { worktreeCardProperties: migratedCardProps } : {}),
    // Keep the old marker for rollback builds; the new marker gates migration.
    _inlineAgentsDefaultedForExperiment: true,
    _inlineAgentsDefaultedForAllUsers: true,
    _expandedWorktreeCardPropertiesDefaulted: true,
    _jiraIssueWorktreeCardPropertyDefaulted: true,
    _hostWorktreeCardPropertyDefaulted: true
  }
}
