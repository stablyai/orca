import { HOOK_INSTALL_ERRNO_CODE_PATTERN } from '../../shared/telemetry-daemon-event-schemas'
import type { HookInstallAgent } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

// Why (#21492): raw messages embed absolute paths under the home directory (and so the OS user
// name) or echo config contents; only a fixed category may leave the machine.
function categorizeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && HOOK_INSTALL_ERRNO_CODE_PATTERN.test(code)) {
      return code
    }
  }
  if (error instanceof SyntaxError) {
    return 'SyntaxError'
  }
  return 'unknown'
}

export function recordManagedHookInstallFailure(agent: HookInstallAgent, error: unknown): void {
  try {
    track('agent_hook_install_failed', {
      agent,
      error_message: categorizeError(error)
    })
  } catch (telemetryError) {
    console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
  }
}
