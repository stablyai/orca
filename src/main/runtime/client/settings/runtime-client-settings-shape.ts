// What a paired client reads and may write of this host's settings.

import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { VoiceSettings } from '../../../../shared/speech/speech-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceCleanupRules } from '../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { SourceControlAiActionDefaults } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { NativeChatDefaultSettings } from '../../../../shared/agent-launch/choices/structured-native-chat-launch-route'

export type RuntimeClientSettings = Pick<
  GlobalSettings,
  | 'defaultTuiAgent'
  | 'newWorkspaceSetupOnly'
  | 'disabledTuiAgents'
  | 'agentCmdOverrides'
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentStatusHooksEnabled'
  | 'codexShareHistoryAcrossAccounts'
  | 'deleteChatHistoryWithWorkspace'
  | 'claudeSubagentNavigationEnabled'
  | 'terminalCopyTrimsGutter'
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'visibleTaskProviders'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
  | 'experimentalNewWorktreeCardStyle'
  | 'worktreeCardDetailsRow'
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
  | 'nativeChatAutoContinueAfterUsageLimit'
  | 'nativeChatQueueFollowUps'
  | 'nativeChatCiResultLines'
  | 'sourceControlGroupOrder'
  | 'sourceControlCompareAgainstUpstream'
  | 'prAutoRefresh'
  | 'diffShowWhitespace'
  | 'newTabMenuLayout'
  | 'floatingTerminalNewTabMenuLayout'
> & {
  /** Always set; older hosts omit it, so clients must not write it to them (settings.update is strict). */
  workspaceCleanupPolicy: WorkspaceCleanupRules
  hostSettingOverrides: RuntimeHostDisplayLabelOverrides
  sourceControlAi: RuntimeClientSourceControlAi
  /** This host's Chat or CLI choice for new agents; null on a headless host nobody set one on. Absent on older hosts. */
  nativeChatDefaults: NativeChatDefaultSettings | null
  /** Models directory and microphone stay host-private. */
  voice: Pick<VoiceSettings, 'enabled' | 'sttModel'>
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
  | 'worktreeCardDetailsRow'
  | 'compactWorktreeCards'
  | 'minimaxGroupId'
  | 'minimaxUsageModels'
  | 'minimaxEndpoint'
  | 'zcodePlanSite'
  | 'prBotAuthorOverrides'
  | 'worktreeVisibilityDefaults'
  | 'machineName'
  | 'nativeChatPermissionMode'
  | 'nativeChatAutoContinueAfterUsageLimit'
  | 'workspaceCleanupPolicy'
  | 'prAutoRefresh'
  | 'newTabMenuLayout'
  | 'floatingTerminalNewTabMenuLayout'
>
