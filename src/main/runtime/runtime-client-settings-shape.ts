// What a paired client reads and may write of this host's settings.

import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { SourceControlAiActionDefaults } from '../../shared/source-control-ai-actions'

export type RuntimeClientSettings = Pick<
  GlobalSettings,
  | 'defaultTuiAgent'
  | 'newWorkspaceSetupOnly'
  | 'disabledTuiAgents'
  | 'agentCmdOverrides'
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentStatusHooksEnabled'
  | 'claudeSubagentNavigationEnabled'
  | 'terminalCopyTrimsGutter'
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'visibleTaskProviders'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
  | 'experimentalNewWorktreeCardStyle'
  | 'experimentalNativeChat'
  | 'compactWorktreeCards'
  | 'minimaxGroupId'
  | 'minimaxUsageModels'
  | 'minimaxEndpoint'
  | 'zcodePlanSite'
  | 'prBotAuthorOverrides'
  | 'artifactSharingEnabled'
  | 'worktreeVisibilityDefaults'
  | 'agentSkillSharingEnabled'
  | 'machineName'
  | 'nativeChatPermissionMode'
> & {
  /** Older clients still read these; neither is persisted or accepted as an update. */
  openAgentTabsInChatByDefault?: boolean
  experimentalStructuredNativeChat?: boolean
  hostSettingOverrides: RuntimeHostDisplayLabelOverrides
  sourceControlAi: RuntimeClientSourceControlAi
}

/** The saved per-action launch recipes (agent, prompt template, agent args), already migrated. */
export type RuntimeClientSourceControlAi = { actions: SourceControlAiActionDefaults }

/** Safe paired projection: host labels only; filesystem defaults stay host-private. */
export type RuntimeHostDisplayLabelOverrides = Partial<
  Record<ExecutionHostId, { displayLabel: string }>
>

export type RuntimeClientSettingsUpdate = Pick<
  Partial<GlobalSettings>,
  | 'agentStatusHooksEnabled'
  | 'claudeSubagentNavigationEnabled'
  | 'experimentalConnectors'
  | 'defaultTuiAgent'
  | 'disabledTuiAgents'
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'visibleTaskProviders'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
  | 'experimentalNewWorktreeCardStyle'
  | 'compactWorktreeCards'
  | 'minimaxGroupId'
  | 'minimaxUsageModels'
  | 'minimaxEndpoint'
  | 'zcodePlanSite'
  | 'prBotAuthorOverrides'
  | 'worktreeVisibilityDefaults'
  | 'machineName'
  | 'nativeChatPermissionMode'
>
