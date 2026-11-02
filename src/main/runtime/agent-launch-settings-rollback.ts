import { isDeepStrictEqual } from 'node:util'
import { isTuiAgent } from '../../shared/tui-agent-config'
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
  const rollback: AgentLaunchSettingsSource = {
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
    ...(Object.hasOwn(updates, 'agentPermissionDefault') &&
    Object.is(current.agentPermissionDefault, applied.agentPermissionDefault)
      ? { agentPermissionDefault: before.agentPermissionDefault }
      : {}),
    ...(Object.hasOwn(updates, 'nativeChatPermissionMode') &&
    Object.is(current.nativeChatPermissionMode, applied.nativeChatPermissionMode)
      ? { nativeChatPermissionMode: before.nativeChatPermissionMode ?? 'ask' }
      : {})
  }
  const fields = [
    'agentDefaultArgs',
    'agentLaunchChoices',
    'agentPermissionOverrides',
    'agentDefaultEnv'
  ] as const
  const changed = new Set(fields.flatMap((field) => Object.keys(updates[field] ?? {})))
  for (const field of fields) {
    if (Object.hasOwn(updates, field)) {
      Object.keys(before[field] ?? {}).forEach((agent) => changed.add(agent))
    }
  }
  for (const agent of changed) {
    if (!isTuiAgent(agent)) {
      continue
    }
    const touched = fields.filter(
      (field) =>
        Object.hasOwn(updates, field) &&
        !isDeepStrictEqual(before[field]?.[agent], applied[field]?.[agent])
    )
    if (
      !touched.length ||
      !fields.every((field) => isDeepStrictEqual(current[field]?.[agent], applied[field]?.[agent]))
    ) {
      continue
    }
    for (const field of touched) {
      const restored = { ...(rollback[field] ?? current[field]) }
      if (before[field] && Object.hasOwn(before[field], agent)) {
        Object.assign(restored, { [agent]: before[field]?.[agent] })
      } else {
        delete restored[agent]
      }
      Object.assign(rollback, { [field]: restored })
    }
  }
  return rollback
}
