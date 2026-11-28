import { isAgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { haveSameDisabledTuiAgents } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { RuntimeClientSettingsUpdate } from './runtime-client-settings-shape'

type HookSettings = Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>>

/** Whether a client's settings update must reconcile this host's managed agent hooks. */
export function runtimeClientUpdateTouchesHooks(
  updates: RuntimeClientSettingsUpdate,
  before: HookSettings,
  after: HookSettings
): boolean {
  return (
    // An explicit enable while already enabled is a repair request (`orca agent hooks on`), so a wiped hook config reinstalls.
    updates.agentStatusHooksEnabled === true ||
    (typeof updates.agentStatusHooksEnabled === 'boolean' &&
      (before.agentStatusHooksEnabled !== false) !== updates.agentStatusHooksEnabled) ||
    (updates.disabledTuiAgents !== undefined &&
      !haveSameDisabledTuiAgents(before.disabledTuiAgents, after.disabledTuiAgents)) ||
    updates.agentHookConsent !== undefined
  )
}

/** A client's decline removes that agent's hooks, as a desktop decline does; reconcile alone only skips. */
export async function removeHooksDeclinedByClient(
  updates: RuntimeClientSettingsUpdate,
  keepSharedEntries: boolean
): Promise<void> {
  const declined = Object.entries(updates.agentHookConsent ?? {})
    .filter(([, decision]) => decision === 'declined')
    .map(([agent]) => agent)
    .filter(isAgentHookTarget)
  if (declined.length === 0 || keepSharedEntries) {
    return
  }
  const { removeManagedAgentHooks } =
    await import('../../../agent-hooks/installation/managed-agent-hook-controls')
  await removeManagedAgentHooks({ agents: declined })
}
