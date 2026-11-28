import {
  isAgentHookTarget,
  type AgentHookConsent
} from '../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import type { AgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
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

// Declines from client updates not yet removed; kept across coalesced reconciles so none is lost.
const pendingClientDeclines = new Set<AgentHookTarget>()

/** Remembers the agents a client's update declines, for the next reconcile to remove. */
export function noteClientDeclines(updates: RuntimeClientSettingsUpdate): void {
  for (const [agent, decision] of Object.entries(updates.agentHookConsent ?? {})) {
    if (decision === 'declined' && isAgentHookTarget(agent)) {
      pendingClientDeclines.add(agent)
    }
  }
}

/**
 * Removes hooks for agents a client declined, as a desktop decline does, if they are still declined.
 * Only those agents: hooks are user-global, so other declines here may be another profile's hooks.
 */
export async function removePendingClientDeclines(
  consent: AgentHookConsent | undefined,
  keepSharedEntries: boolean
): Promise<void> {
  const declined = [...pendingClientDeclines].filter((agent) => consent?.[agent] === 'declined')
  pendingClientDeclines.clear()
  if (declined.length === 0 || keepSharedEntries) {
    return
  }
  const { removeManagedAgentHooks } =
    await import('../../../agent-hooks/installation/managed-agent-hook-controls')
  await removeManagedAgentHooks({ agents: declined })
}
