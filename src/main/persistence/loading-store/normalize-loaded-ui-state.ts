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
  // Why: a short-lived default put Done on the left; repair only the exact raw payload once so user reorders survive.
  const workspaceStatusesReorderedDefaultRepaired =
    parsed.ui?._workspaceStatusesReorderedDefaultRepaired === true
  // Why: only exact legacy default payloads migrate; customized status labels/colors/icons/order are kept.
  const workspaceStatusesDefaultWorkflowMigrated =
    parsed.ui?._workspaceStatusesDefaultWorkflowMigrated === true
  // Why: visual migration has its own guard so later user choices of valid legacy color/icon IDs are preserved.
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
      // Why: Linear rode the 'issue' property and Ports were always shown; split them out once to preserve existing cards.
      if (candidate.includes('issue') && !candidate.includes('linear-issue')) {
        next.push('linear-issue' as const)
      }
      if (!candidate.includes('ports')) {
        next.push('ports' as const)
      }
      return next
    })()
    // Why: 'jira-issue' joined the defaults after the expansion migration already stamped upgraded profiles, so it needs its own one-shot backfill.
    const jiraCandidate =
      jiraIssueCardPropDefaulted || expandedCandidate.includes('jira-issue')
        ? expandedCandidate
        : [...expandedCandidate, 'jira-issue' as const]
    const normalized = normalizeWorktreeCardProperties(jiraCandidate)
    const changed =
      normalized.length !== rawCardProps.length ||
      normalized.some((property, index) => property !== rawCardProps[index])
    return changed ? normalized : undefined
  })()
  if (
    migratedCardProps !== undefined ||
    !inlineAgentsMigrated ||
    !expandedCardPropsMigrated ||
    !jiraIssueCardPropDefaulted
  ) {
    markNeedsSave()
  }
  const rawExplorerView = parsed.ui?.rightSidebarExplorerView
  const rightSidebarExplorerView = normalizeRightSidebarExplorerView(
    rawExplorerView,
    parsed.ui?.rightSidebarTab
  )
  // Why: without a dirty mark the legacy "Search tab, no explorer view" repair stays
  // in memory only, so a profile that never writes again redoes it on every launch.
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
  // Why: only upgraded profiles still on the new default get the one-time usage-display notice; fresh profiles stay quiet.
  const usagePercentageDisplayChangeNoticeDismissed =
    resolveUsagePercentageDisplayChangeNoticeDismissed({
      rawDismissed: parsed.ui?.usagePercentageDisplayChangeNoticeDismissed,
      rawUsagePercentageDisplay: parsed.ui?.usagePercentageDisplay,
      isExistingProfile: isExistingPersistedProfile({
        repoCount: parsed.repos?.length ?? 0,
        onboardingClosedAt: normalizedOnboarding.closedAt,
        ui: parsed.ui
      })
    })
  if (
    parsed.ui?.usagePercentageDisplayChangeNoticeDismissed !==
    usagePercentageDisplayChangeNoticeDismissed
  ) {
    markNeedsSave()
  }
  return {
    ...defaults.ui,
    // Why: missing card properties follow the persisted layout mode; explicit choices are preserved below.
    worktreeCardProperties: getWorktreeCardModeProperties(
      loadedCompactWorktreeCards ? 'Compact' : 'Default'
    ),
    ...stripMainOwnedTelemetryMarkerFromUI(parsed.ui),
    // Why: migrate once from the retired Appearance setting only when no explicit chrome preference exists yet.
    rightSidebarOpen,
    rightSidebarTab: normalizeRightSidebarTab(parsed.ui?.rightSidebarTab),
    // Why here and not in getPersistedUI: only the raw payload still shows the legacy
    // "Search tab, no explorer view" shape — the defaults spread above fills in 'files'.
    rightSidebarExplorerView,
    setupGuideSidebarDismissed,
    usagePercentageDisplayChangeNoticeDismissed,
    setupGuideBrowserMilestoneMigrated:
      typeof parsed.ui?.setupGuideBrowserMilestoneMigrated === 'boolean'
        ? parsed.ui.setupGuideBrowserMilestoneMigrated
        : false,
    setupGuideBrowserMilestoneLegacyComplete:
      parsed.ui?.setupGuideBrowserMilestoneLegacyComplete === true,
    // Why persist rather than notify inline: the flip lands during load, before any
    // window exists, and it must survive a crash before the user ever sees the notice.
    osc52ClipboardDefaultOnNoticePending: osc52ClipboardNoticePending,
    sortBy: migrate ? ('smart' as const) : sort,
    showDotfilesByWorktree: normalizeShowDotfilesByWorktree(parsed.ui?.showDotfilesByWorktree),
    workspaceStatuses,
    _workspaceStatusesDefaultOrderMigrated: true,
    _workspaceStatusesReorderedDefaultRepaired: true,
    _workspaceStatusesDefaultWorkflowMigrated: true,
    _workspaceStatusesDefaultVisualsMigrated: true,
    _sortBySmartMigrated: true,
    ...(migratedCardProps !== undefined ? { worktreeCardProperties: migratedCardProps } : {}),
    // Why: keep stamping the legacy flag for rollback forward-compat; the new flag actually gates the migration.
    _inlineAgentsDefaultedForExperiment: true,
    _inlineAgentsDefaultedForAllUsers: true,
    _expandedWorktreeCardPropertiesDefaulted: true,
    _jiraIssueWorktreeCardPropertyDefaulted: true
  }
}
