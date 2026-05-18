import { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/types'
import { defineMethod, type RpcMethod } from '../core'

const NullableString = z.string().nullable()
const StringArray = z.array(z.string())
const UnknownRecord = z.record(z.string(), z.unknown())
const UnknownRecordArray = z.array(UnknownRecord)
const WorktreeCardProperty = z.enum([
  'status',
  'unread',
  'ci',
  'issue',
  'pr',
  'comment',
  'inline-agents'
])
const StatusBarItem = z.enum(['claude', 'codex', 'gemini', 'opencode-go', 'ssh', 'resource-usage'])
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

const UiUpdate = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    sidebarWidth: z.number().finite().optional(),
    rightSidebarWidth: z.number().finite().optional(),
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    showWorkspaceLineage: z.boolean().optional(),
    sortBy: z.enum(['name', 'smart', 'recent', 'repo']).optional(),
    showActiveOnly: z.boolean().optional(),
    hideDefaultBranchWorkspace: z.boolean().optional(),
    filterRepoIds: StringArray.optional(),
    collapsedGroups: StringArray.optional(),
    uiZoomLevel: z.number().finite().optional(),
    editorFontZoomLevel: z.number().finite().optional(),
    worktreeCardProperties: z.array(WorktreeCardProperty).optional(),
    workspaceStatuses: z.array(WorkspaceStatusDefinition).optional(),
    workspaceBoardOpacity: z.number().finite().optional(),
    workspaceBoardCompact: z.boolean().optional(),
    workspaceBoardColumnWidth: z.number().finite().optional(),
    _workspaceStatusesDefaultOrderMigrated: z.boolean().optional(),
    _workspaceStatusesDefaultWorkflowMigrated: z.boolean().optional(),
    _workspaceStatusesDefaultVisualsMigrated: z.boolean().optional(),
    statusBarItems: z.array(StatusBarItem).optional(),
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
    starNagBaselineAgents: z.number().finite().nullable().optional(),
    starNagAppVersion: NullableString.optional(),
    starNagNextThreshold: z.number().finite().optional(),
    starNagCompleted: z.boolean().optional(),
    trustedOrcaHooks: z.record(z.string(), z.unknown()).optional(),
    petVisible: z.boolean().optional(),
    petId: z.string().optional(),
    customPets: UnknownRecordArray.optional(),
    petSize: z.number().finite().optional(),
    sidekickVisible: z.boolean().optional(),
    sidekickId: z.string().optional(),
    customSidekicks: UnknownRecordArray.optional(),
    sidekickSize: z.number().finite().optional(),
    taskResumeState: TaskResumeState.optional(),
    workspaceCleanup: WorkspaceCleanup.optional()
  })
  .strict()
  .default({})

export const CLIENT_UI_METHODS: RpcMethod[] = [
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
  })
]
