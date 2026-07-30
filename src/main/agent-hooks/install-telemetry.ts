import type { HookInstallAgent } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

const ERROR_MESSAGE_MAX_LEN = 200

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    const json = JSON.stringify(error)
    return typeof json === 'string' ? json : String(error)
  } catch {
    return String(error)
  }
}

export function recordManagedHookInstallFailure(agent: HookInstallAgent, error: unknown): void {
  try {
    track('agent_hook_install_failed', {
      agent,
      error_message: describeError(error).slice(0, ERROR_MESSAGE_MAX_LEN)
    })
  } catch (telemetryError) {
    console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
  }
}
