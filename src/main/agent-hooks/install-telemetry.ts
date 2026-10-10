import type { HookInstallAgent } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

/**
 * Why (#26604): the telemetry docs promise raw error messages never leave the
 * machine — they can contain paths and user names, e.g.
 * "EACCES: permission denied, open '/home/<user>/.claude/settings.json'".
 * Only errno-style system codes or error class names are reported; anything
 * else (including caller-set free-form `code` strings) degrades to 'unknown'.
 */
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/
const SAFE_CLASS_NAME_RE = /^[A-Za-z][A-Za-z0-9_$]*$/

function describeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && SAFE_ERROR_CODE_RE.test(code)) {
      return code.slice(0, 64)
    }
    // Object.create(null) has no constructor; a missing or odd-shaped name
    // must not swallow the whole telemetry event.
    const className = (error as object).constructor?.name
    if (typeof className === 'string' && SAFE_CLASS_NAME_RE.test(className)) {
      return className.slice(0, 64)
    }
  }
  return 'unknown'
}

export function recordManagedHookInstallFailure(agent: HookInstallAgent, error: unknown): void {
  try {
    track('agent_hook_install_failed', {
      agent,
      error_code: describeErrorCode(error)
    })
  } catch (telemetryError) {
    console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
  }
}
