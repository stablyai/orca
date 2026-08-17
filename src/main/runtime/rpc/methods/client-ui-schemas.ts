import { z } from 'zod'
import {
  isFeatureInteractionId,
  type FeatureInteractionId
} from '../../../../shared/feature-interactions'
import { isFeatureTipId } from '../../../../shared/feature-tips'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../../shared/tui-agent-launch-defaults'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isTaskProvider } from '../../../../shared/task-providers'
import { isReleaseChannel, type ReleaseChannel } from '../../../../shared/release-channel'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizePRBotAuthorOverrides } from '../../../../shared/pr-bot-author-overrides'
import {
  normalizeWorktreeCardProperties,
  WORKTREE_CARD_PROPERTIES
} from '../../../../shared/worktree/card-properties'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import type { TaskProvider } from '../../../../shared/task-providers'
import { ClientUiWorkspaceFilterFields } from './client-ui-workspace-filter-fields'
import { TaskResumeState } from './task-resume-state-schema'
import { WorkspaceCleanup } from './workspace-cleanup-ui-schema'
import { omitUndefinedValues, tolerateUnknownValues } from './ui-update-value-tolerance'
import { WorktreeVisibilityDefaultsUpdate } from './worktree-visibility-defaults-schema'

const NullableString = z.string().nullable()
const StringArray = z.array(z.string())
const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})
const FeatureTipIds = z.array(z.custom(isFeatureTipId, { message: 'Unknown feature tip id' }))
const UnknownRecord = z.record(z.string(), z.unknown())
const UnknownRecordArray = z.array(UnknownRecord)
type StaticRightSidebarTab = (typeof STATIC_RIGHT_SIDEBAR_TABS)[number]
// Derived from the shared union so a new card property cannot drift out of the
// client schema — it previously omitted 'cli' and rejected the whole payload.
const WorktreeCardPropertyParam = z.enum(WORKTREE_CARD_PROPERTIES)
const WorktreeCardProperties = z
  .array(WorktreeCardPropertyParam)
  .transform((value) => normalizeWorktreeCardProperties(value))
const STATIC_RIGHT_SIDEBAR_TABS = [
  'explorer',
  'search',
  'vault',
  'workspaces',
  'pr-checks',
  'source-control',
  'checks',
  'ports'
] as const
// Plugin panels are open-ended `plugin:<publisher>.<id>/<panel>` keys, so the
// schema validates their shape rather than enumerating them.
const RightSidebarTabParam = z.custom<StaticRightSidebarTab | `plugin:${string}`>(
  (value) =>
    typeof value === 'string' &&
    (STATIC_RIGHT_SIDEBAR_TABS.includes(value as StaticRightSidebarTab) ||
      isPluginPanelTabKey(value)),
  { message: 'Unknown right sidebar tab' }
)
const AgentActivityDisplayMode = z.enum(['compact', 'full'])
const StatusBarItem = z.enum([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'ssh',
  'resource-usage',
  'ports'
])
const WorkspaceStatusDefinition = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().optional(),
  icon: z.string().optional()
})
const FeatureInteractionRecord = z
  .object({
    firstInteractedAt: z.number().finite().nonnegative(),
    interactionCount: z.number().int().positive().optional()
  })
  .strict()
const FeatureInteractions = z
  .record(z.string(), FeatureInteractionRecord)
  .superRefine((value, ctx) => {
    for (const id of Object.keys(value)) {
      if (!isFeatureInteractionId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown feature interaction id: ${id}`,
          path: [id]
        })
      }
    }
  })
export const FeatureInteractionIdParam = z.custom<FeatureInteractionId>(isFeatureInteractionId, {
  message: 'Unknown feature interaction id'
})
export const PRBotAuthorOverrideUpdate = z
  .object({ author: z.string(), isBot: z.boolean() })
  .strict()
const GitHubProjectRef = z
  .object({
    owner: z.string(),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int(),
    host: z.string().optional()
  })
  .strict()
const GitHubProjectSettings = z
  .object({
    pinned: z.array(GitHubProjectRef),
    recent: z.array(
      GitHubProjectRef.extend({
        lastOpenedAt: z.string()
      }).strict()
    ),
    lastViewByProject: z.record(z.string(), z.object({ viewId: z.string() }).strict()),
    activeProject: GitHubProjectRef.nullable()
  })
  .strict()

export const SettingsUpdate = z
  .object({
    worktreeVisibilityDefaults: WorktreeVisibilityDefaultsUpdate.optional(),
    defaultTuiAgent: z
      .unknown()
      .transform((value) =>
        value === null || value === 'blank' || isTuiAgent(value) ? value : undefined
      )
      .optional(),
    disabledTuiAgents: z
      .unknown()
      .transform((value) => normalizeDisabledTuiAgents(value))
      .optional(),
    agentDefaultArgs: z
      .unknown()
      .transform((value) => normalizeTuiAgentArgsRecord(value))
      .optional(),
    agentDefaultEnv: z
      .unknown()
      .transform((value) => normalizeTuiAgentEnvRecord(value))
      .optional(),
    defaultTaskSource: TaskProviderParam.optional(),
    visibleTaskProviders: z.array(TaskProviderParam).optional(),
    defaultTaskViewPreset: z
      .enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
      .optional(),
    experimentalNewWorktreeCardStyle: z.boolean().optional(),
    agentStatusHooksEnabled: z.boolean().optional(),
    defaultRepoSelection: z.array(z.string()).nullable().optional(),
    defaultLinearTeamSelection: z.array(z.string()).nullable().optional(),
    compactWorktreeCards: z.boolean().optional(),
    minimaxGroupId: z.string().optional(),
    minimaxUsageModels: z.string().optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: z
      .unknown()
      .transform((value) => normalizePRBotAuthorOverrides(value))
      .optional()
  })
  .strict()
  .default({})

const TopLevelViewSchema = z.enum([
  'terminal',
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'artifacts',
  'mobile'
])
const UiUpdateFields = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    // Why: sync hydration ignores this persisted startup view, so paired windows stay put.
    activeView: TopLevelViewSchema.optional(),
    sidebarWidth: z.number().finite().optional(),
    rightSidebarOpen: z.boolean().optional(),
    rightSidebarTab: RightSidebarTabParam.optional(),
    rightSidebarExplorerView: z.enum(['files', 'search']).optional(),
    rightSidebarWidth: z.number().finite().optional(),
    markdownTocPanelWidth: z.number().finite().optional(),
    combinedDiffFileTreeWidth: z.number().finite().optional(),
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    showWorkspaceLineage: z.boolean().optional(),
    sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional(),
    projectOrderBy: z.enum(['manual', 'recent']).optional(),
    showActiveOnly: z.boolean().optional(),
    hideSleepingWorkspaces: z.boolean().optional(),
    showSleepingWorkspaces: z.boolean().optional(),
    showInactiveWorkspaces: z.boolean().optional(),
    workspaceHostScope: z.string().optional(),
    visibleWorkspaceHostIds: z.array(z.string()).nullable().optional(),
    workspaceHostOrder: z.array(z.string()).optional(),
    manualRepoOrder: z
      .array(z.object({ hostId: z.string(), repoId: z.string() }).strict())
      .optional(),
    ...ClientUiWorkspaceFilterFields,
    // Why: rides App.tsx's debounced writer, so omitting it rejected that entire
    // payload (sidebar widths, filters, agent acks) for every paired client.
    showDotfilesByWorktree: z.record(z.string(), z.boolean()).optional(),
    collapsedGroups: StringArray.optional(),
    uiZoomLevel: z.number().finite().optional(),
    editorFontZoomLevel: z.number().finite().optional(),
    worktreeCardProperties: WorktreeCardProperties.optional(),
    _worktreeCardModeDefaulted: z.boolean().optional(),
    agentActivityDisplayMode: AgentActivityDisplayMode.optional(),
    workspaceStatuses: z.array(WorkspaceStatusDefinition).optional(),
    workspaceBoardOpacity: z.number().finite().optional(),
    workspaceBoardColumnWidth: z.number().finite().optional(),
    syncTaskStatusFromWorkspaceBoard: z.boolean().optional(),
    _workspaceStatusesDefaultOrderMigrated: z.boolean().optional(),
    _workspaceStatusesReorderedDefaultRepaired: z.boolean().optional(),
    _workspaceStatusesDefaultWorkflowMigrated: z.boolean().optional(),
    _workspaceStatusesDefaultVisualsMigrated: z.boolean().optional(),
    statusBarItems: z.array(StatusBarItem).optional(),
    _portsStatusBarDefaultAdded: z.boolean().optional(),
    _kimiStatusBarDefaultAdded: z.boolean().optional(),
    _minimaxStatusBarDefaultAdded: z.boolean().optional(),
    _antigravityStatusBarDefaultAdded: z.boolean().optional(),
    _grokStatusBarDefaultAdded: z.boolean().optional(),
    statusBarVisible: z.boolean().optional(),
    usagePercentageDisplay: z.enum(['used', 'remaining']).optional(),
    statusBarUsageMode: z.enum(['verbose', 'compact']).optional(),
    dismissedUpdateVersion: NullableString.optional(),
    lastUpdateCheckAt: z.number().finite().nullable().optional(),
    pendingUpdateNudgeId: NullableString.optional(),
    dismissedUpdateNudgeId: NullableString.optional(),
    // Why the predicate rather than an inline z.enum: an enum here is a copy of
    // RELEASE_CHANNELS, and a copy that drifts silently rejects the new
    // channel's override on its way here — the picker moves, nothing installs.
    releaseChannelOverride: z.custom<ReleaseChannel>(isReleaseChannel).nullable().optional(),
    notificationPermissionRequested: z.boolean().optional(),
    updateReassuranceSeen: z.boolean().optional(),
    osc52ClipboardDefaultOnNoticePending: z.boolean().optional(),
    acknowledgedAgentsByPaneKey: z.record(z.string(), z.number().finite()).optional(),
    browserDefaultUrl: NullableString.optional(),
    browserDefaultSearchEngine: z
      .enum(['google', 'duckduckgo', 'bing', 'kagi'])
      .nullable()
      .optional(),
    browserDefaultZoomLevel: z.number().finite().optional(),
    browserKagiSessionLink: NullableString.optional(),
    windowBounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite()
      })
      .nullable()
      .optional(),
    windowMaximized: z.boolean().optional(),
    _sortBySmartMigrated: z.boolean().optional(),
    _inlineAgentsDefaultedForExperiment: z.boolean().optional(),
    _inlineAgentsDefaultedForAllUsers: z.boolean().optional(),
    trustedOrcaHooks: z.record(z.string(), z.unknown()).optional(),
    setupScriptPromptDismissedRepoIds: StringArray.optional(),
    // Why: one-shot dismissals the renderer writes through ui.set; each was a
    // whole-payload rejection for paired clients while unlisted.
    setupGuideSidebarDismissed: z.boolean().optional(),
    setupGuideBrowserMilestoneMigrated: z.boolean().optional(),
    setupGuideBrowserMilestoneLegacyComplete: z.boolean().optional(),
    browserImportHintHidden: z.boolean().optional(),
    mobileEmulatorTabIntroDismissed: z.boolean().optional(),
    mobileEmulatorAgentSetupDismissed: z.boolean().optional(),
    projectOrderManualDefaultNoticeDismissed: z.boolean().optional(),
    usagePercentageDisplayChangeNoticeDismissed: z.boolean().optional(),
    usageEmptyStateDismissed: z.boolean().optional(),
    petVisible: z.boolean().optional(),
    petId: z.string().optional(),
    customPets: UnknownRecordArray.optional(),
    petSize: z.number().finite().optional(),
    sidekickVisible: z.boolean().optional(),
    sidekickId: z.string().optional(),
    customSidekicks: UnknownRecordArray.optional(),
    sidekickSize: z.number().finite().optional(),
    taskResumeState: TaskResumeState.optional(),
    workspaceCleanup: WorkspaceCleanup.optional(),
    featureTipsSeenIds: FeatureTipIds.optional(),
    featureInteractions: FeatureInteractions.optional(),
    contextualToursSeenIds: StringArray.optional(),
    contextualToursAutoEligible: z.boolean().optional()
  })
  .strict()

export const UiUpdate = z
  .object(tolerateUnknownValues(UiUpdateFields.shape))
  .strict()
  .default({})
  .transform(omitUndefinedValues)

// The key/value parity assertions over this live in ui-state-schema-parity-checks.ts.
export type UiUpdateFieldsSchema = typeof UiUpdateFields
