// Per-agent managed-hook installer with fail-open semantics and PostHog
// attribution. Lifted out of `src/main/index.ts` so the loop is unit-testable
// without standing up the full Electron startup graph — the catch site needs
// the agent label to fire `agent_hook_install_failed`, and the previous
// closure-style loop lost it.

import type { HookInstallAgent } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

// Why: install errors are about config-file shape (malformed JSON, ACL
// denial), not user content — but messages can include paths or stack
// fragments. The 200-char cap matches `agentHookInstallFailedSchema.error_message`
// in `src/shared/telemetry-events.ts`; the validator drops overlength values,
// so truncation must happen here at the call site.
const ERROR_MESSAGE_MAX_LEN = 200

export type ManagedHookInstaller = readonly [HookInstallAgent, () => void]

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

export function runManagedHookInstallers(installers: readonly ManagedHookInstaller[]): void {
  for (const [agent, install] of installers) {
    try {
      install()
    } catch (error) {
      console.error(`[agent-hooks] Failed to install ${agent} managed hooks:`, error)
      // Why: telemetry must not break fail-open. A throw inside `track` (e.g.
      // a corrupted settings store the resolveConsent path reads from) would
      // otherwise abort the for-loop and skip later agents' installers.
      try {
        track('agent_hook_install_failed', {
          agent,
          error_message: describeError(error).slice(0, ERROR_MESSAGE_MAX_LEN)
        })
      } catch (telemetryError) {
        console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
      }
    }
  }
}
