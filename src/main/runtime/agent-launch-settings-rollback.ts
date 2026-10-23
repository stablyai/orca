import type { AgentLaunchSettingsSource } from '../../shared/agent-launch-settings'

export function agentLaunchSettingsRollbackUpdates(
  before: AgentLaunchSettingsSource,
  applied: AgentLaunchSettingsSource,
  current: AgentLaunchSettingsSource,
  updates: AgentLaunchSettingsSource
): AgentLaunchSettingsSource {
  // A newer default choice supersedes both fields, including None → Blank with the same agent.
  const defaultUnchanged =
    Object.is(current.defaultTuiAgent, applied.defaultTuiAgent) &&
    (!Object.hasOwn(updates, 'newWorkspaceSetupOnly') ||
      Object.is(current.newWorkspaceSetupOnly, applied.newWorkspaceSetupOnly))
  // A newer full-field write supersedes this mutation and must survive its rollback.
  return {
    ...(Object.hasOwn(updates, 'defaultTuiAgent') && defaultUnchanged
      ? { defaultTuiAgent: before.defaultTuiAgent ?? null }
      : {}),
    ...(Object.hasOwn(updates, 'newWorkspaceSetupOnly') && defaultUnchanged
      ? { newWorkspaceSetupOnly: before.newWorkspaceSetupOnly === true }
      : {}),
    ...(Object.hasOwn(updates, 'disabledTuiAgents') &&
    Object.is(current.disabledTuiAgents, applied.disabledTuiAgents)
      ? { disabledTuiAgents: before.disabledTuiAgents ?? [] }
      : {}),
    ...(Object.hasOwn(updates, 'agentCmdOverrides') &&
    Object.is(current.agentCmdOverrides, applied.agentCmdOverrides)
      ? { agentCmdOverrides: before.agentCmdOverrides ?? {} }
      : {}),
    ...(Object.hasOwn(updates, 'agentDefaultArgs') &&
    Object.is(current.agentDefaultArgs, applied.agentDefaultArgs)
      ? { agentDefaultArgs: before.agentDefaultArgs ?? {} }
      : {}),
    ...(Object.hasOwn(updates, 'agentDefaultEnv') &&
    Object.is(current.agentDefaultEnv, applied.agentDefaultEnv)
      ? { agentDefaultEnv: before.agentDefaultEnv ?? {} }
      : {}),
    ...(Object.hasOwn(updates, 'agentNativeChatPermissionModes') &&
    Object.is(current.agentNativeChatPermissionModes, applied.agentNativeChatPermissionModes)
      ? { agentNativeChatPermissionModes: before.agentNativeChatPermissionModes ?? {} }
      : {}),
    ...(Object.hasOwn(updates, 'nativeChatPermissionMode') &&
    Object.is(current.nativeChatPermissionMode, applied.nativeChatPermissionMode)
      ? { nativeChatPermissionMode: before.nativeChatPermissionMode ?? 'ask' }
      : {})
  }
}
