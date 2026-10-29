import { errnoCodeOrUnknown } from '../../shared/errno-code'
import type { HookInstallAgent } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

export function recordManagedHookInstallFailure(agent: HookInstallAgent, error: unknown): void {
  try {
    track('agent_hook_install_failed', {
      agent,
      error_message: errnoCodeOrUnknown(error)
    })
  } catch (telemetryError) {
    console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
  }
}
