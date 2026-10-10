import type { AgentLaunchSettingsSource } from '../../shared/agent-launch-settings'

export function agentLaunchSettingsRollbackUpdates(
  before: AgentLaunchSettingsSource,
  applied: AgentLaunchSettingsSource,
  current: AgentLaunchSettingsSource,
  updates: AgentLaunchSettingsSource
): AgentLaunchSettingsSource {
  // A newer full-field write supersedes this mutation and must survive its rollback.
  return {
    ...(Object.hasOwn(updates, 'defaultTuiAgent') &&
    Object.is(current.defaultTuiAgent, applied.defaultTuiAgent)
      ? { defaultTuiAgent: before.defaultTuiAgent ?? null }
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
      : {})
  }
}
