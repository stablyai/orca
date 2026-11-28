import {
  isAgentHookTarget,
  type AgentHookConsent
} from '../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
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

/**
 * Removes hooks for every agent the saved settings decline, as a desktop decline does. Read from the
 * store, not the update, so a reconcile that superseded an earlier decline still removes it.
 */
export async function removeHooksForDeclinedAgents(
  consent: AgentHookConsent | undefined,
  keepSharedEntries: boolean
): Promise<void> {
  const declined = Object.entries(consent ?? {})
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
