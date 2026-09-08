import { isDeepStrictEqual } from 'node:util'
import { AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AUTO_TUI_AGENT_ARGS, AUTO_TUI_AGENT_ENV } from '../../../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  RuntimeClientSettings,
  RuntimeClientSettingsUpdate
} from '../../runtime-client-settings'
import type { RpcContext } from '../core'

type ClientContext = Pick<RpcContext, 'clientCapabilities' | 'clientKind'>

export function projectClientPermissionSettings(
  settings: RuntimeClientSettings,
  context: ClientContext
): RuntimeClientSettings {
  if (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY)
  ) {
    return settings
  }
  let projected = settings
  for (const [agent, preset] of Object.entries(AUTO_TUI_AGENT_ARGS)) {
    if (settings.agentDefaultArgs?.[agent as TuiAgent]?.trim() === preset) {
      projected = {
        ...projected,
        agentDefaultArgs: { ...projected.agentDefaultArgs, [agent]: '' }
      }
    }
  }
  for (const [agent, preset] of Object.entries(AUTO_TUI_AGENT_ENV)) {
    if (isDeepStrictEqual(settings.agentDefaultEnv?.[agent as TuiAgent], preset)) {
      projected = {
        ...projected,
        agentDefaultEnv: { ...projected.agentDefaultEnv, [agent]: {} }
      }
    }
  }
  return projected
}

export function protectClientPermissionUpdate(
  updates: RuntimeClientSettingsUpdate,
  context: RpcContext
): RuntimeClientSettingsUpdate {
  if (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_PERMISSION_AUTO_RUNTIME_CAPABILITY) ||
    (updates.agentDefaultArgs === undefined && updates.agentDefaultEnv === undefined)
  ) {
    return updates
  }
  const settings = context.runtime.getClientSettings()
  const projected = projectClientPermissionSettings(settings, context)
  if (projected === settings) {
    return updates
  }

  // Legacy onboarding turns an unrecognized permission profile into bypass.
  for (const field of ['agentDefaultArgs', 'agentDefaultEnv'] as const) {
    if (updates[field] !== undefined && !isDeepStrictEqual(updates[field], projected[field])) {
      throw new Error('Update this Orca client to change permissions while Auto mode is enabled.')
    }
  }
  const { agentDefaultArgs: _args, agentDefaultEnv: _env, ...remaining } = updates
  return remaining
}
