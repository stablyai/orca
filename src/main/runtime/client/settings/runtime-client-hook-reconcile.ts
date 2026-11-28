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
