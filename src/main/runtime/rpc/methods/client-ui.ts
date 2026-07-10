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
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeWorktreeCardProperties } from '../../../../shared/worktree-card-properties'
import type { PersistedUIState, TaskProvider } from '../../../../shared/types'
import { defineMethod, type RpcMethod } from '../core'

const NullableString = z.string().nullable()
const StringArray = z.array(z.string())
const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})
const FeatureTipIds = z.array(z.custom(isFeatureTipId, { message: 'Unknown feature tip id' }))
const UnknownRecord = z.record(z.string(), z.unknown())
const UnknownRecordArray = z.array(UnknownRecord)
const LegacyWorktreeCardProperty = z.enum([
  'status',
  'unread',
  'ci',
  'branch',
  'issue',
  'linear-issue',
  'pr',
  'automation',
  'comment',
  'ports',
  'inline-agents'
])
const WorktreeCardProperties = z
  .array(LegacyWorktreeCardProperty)
  .transform((value) => normalizeWorktreeCardProperties(value))
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
const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: z.string().nullable().optional(),
    githubItemsQuery: z.string().optional(),
    githubProjectHiddenFieldIdsByView: z.record(z.string(), z.array(z.string())).optional(),
    linearPreset: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    linearQuery: z.string().optional()
  })
  .strict()
const WorkspaceCleanupDismissal = z
  .object({
    worktreeId: z.string(),
    dismissedAt: z.number().finite(),
    fingerprint: z.string(),
    classifierVersion: z.number().finite()
  })
  .strict()
const WorkspaceCleanup = z
  .object({
    dismissals: z.record(z.string(), WorkspaceCleanupDismissal)
  })
  .strict()
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
const FeatureInteractionIdParam = z.custom<FeatureInteractionId>(isFeatureInteractionId, {
  message: 'Unknown feature interaction id'
})
const GitHubProjectRef = z
  .object({
    owner: z.string(),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int()
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

const SettingsUpdate = z
  .object({
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
    githubProjects: GitHubProjectSettings.optional()
  })
  .strict()
  .default({})

const UiUpdate = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    sidebarWidth: z.number().finite().optional(),
    rightSidebarOpen: z.boolean().optional(),
    rightSidebarTab: z
      .enum(['explorer', 'search', 'vault', 'source-control', 'checks', 'ports'])
      .optional(),
    rightSidebarExplorerView: z.enum(['files', 'search']).optional(),
    rightSidebarWidth: z.number().finite().optional(),
    markdownTocPanelWidth: z.number().finite().optional(),
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
    hideDefaultBranchWorkspace: z.boolean().optional(),
    hideAutomationGeneratedWorkspaces: z.boolean().optional(),
    filterRepoIds: StringArray.optional(),
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
    dismissedUpdateVersion: NullableString.optional(),
    lastUpdateCheckAt: z.number().finite().nullable().optional(),
    pendingUpdateNudgeId: NullableString.optional(),
    dismissedUpdateNudgeId: NullableString.optional(),
    notificationPermissionRequested: z.boolean().optional(),
    updateReassuranceSeen: z.boolean().optional(),
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
    projectOrderManualDefaultNoticeDismissed: z.boolean().optional(),
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
  .default({})

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.get',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getClientSettings() })
  }),
  defineMethod({
    name: 'settings.update',
    params: SettingsUpdate,
    handler: (params, { runtime }) => ({ settings: runtime.updateClientSettings(params) })
  }),
  defineMethod({
    name: 'ui.get',
    params: null,
    handler: (_params, { runtime }) => ({ ui: runtime.getUIState() })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    handler: (params, { runtime }) => ({
      ui: runtime.updateUIState(params as Partial<PersistedUIState>)
    })
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    params: FeatureInteractionIdParam,
    handler: (params, { runtime }) => ({
      ui: runtime.recordFeatureInteraction(params)
    })
  })
]
