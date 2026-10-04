import type { CodexAppServerHostKey } from './codex-app-server-capability-cache'

// Why: a transiently hung app-server must not block launch prep on every pane.
// The legacy lane remains available while a short, host-scoped cooldown runs.
export const CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS = 5 * 60_000
const MAX_TRANSIENT_TRUST_COOLDOWNS = 256

// Why launch-path grants only: a background grant's retry is scheduled by its
// caller's lane, so a second schedule here could only disagree with it.
const retryAfterByHost = new Map<string, number>()

export function isCodexTrustGrantCoolingDown(hostKey: CodexAppServerHostKey): boolean {
  const retryAfter = retryAfterByHost.get(hostKey)
  if (retryAfter === undefined) {
    return false
  }
  if (Date.now() < retryAfter) {
    return true
  }
  retryAfterByHost.delete(hostKey)
  return false
}

export function startCodexTrustGrantCooldown(hostKey: CodexAppServerHostKey): void {
  retryAfterByHost.delete(hostKey)
  retryAfterByHost.set(hostKey, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
  while (retryAfterByHost.size > MAX_TRANSIENT_TRUST_COOLDOWNS) {
    const oldest = retryAfterByHost.keys().next().value
    if (oldest === undefined) {
      break
    }
    retryAfterByHost.delete(oldest)
  }
}

/** A success or a proven-missing surface, from either lane, ends the host's cooldown. */
export function clearCodexTrustGrantCooldown(hostKey: CodexAppServerHostKey): void {
  retryAfterByHost.delete(hostKey)
}

export function resetCodexTrustGrantCooldowns(): void {
  retryAfterByHost.clear()
}

export function countCodexTrustGrantCooldowns(): number {
  return retryAfterByHost.size
}
