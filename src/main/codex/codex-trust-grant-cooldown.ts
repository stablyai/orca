import type { CodexAppServerHostKey } from './app-server/codex-app-server-capability-cache'

// Use legacy trust during the host cooldown so a hung server cannot delay every pane.
export const CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS = 5 * 60_000
const MAX_TRANSIENT_TRUST_COOLDOWNS = 256

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

export function clearCodexTrustGrantCooldown(hostKey: CodexAppServerHostKey): void {
  retryAfterByHost.delete(hostKey)
}

export function resetCodexTrustGrantCooldowns(): void {
  retryAfterByHost.clear()
}

export function countCodexTrustGrantCooldowns(): number {
  return retryAfterByHost.size
}
