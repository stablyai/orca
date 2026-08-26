import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { restoreCodexTrustConfigIfUnchanged } from './codex-trust-config-generation'
import type { CodexTrustConfigSnapshot } from './codex-trust-config-rollback'

export function removeSelfComputedTrustBeforeGrant(plan: {
  tomlPath: string
  managedEntries: readonly CodexTrustEntry[]
}): void {
  const trustStates = readHookTrustEntries(plan.tomlPath)
  const ownedKeys = plan.managedEntries
    .map((entry) => {
      const key = computeTrustKey(entry)
      return trustStates.get(key)?.trustedHash === computeTrustedHash(entry) ? key : null
    })
    .filter((key): key is string => key !== null)
  if (ownedKeys.length > 0) {
    removeHookTrustEntries(plan.tomlPath, ownedKeys)
  }
}

export function restoreGrantConfigIfUnchanged(
  tomlPath: string,
  snapshot: CodexTrustConfigSnapshot,
  expected: CodexTrustConfigSnapshot
): void {
  if (!restoreCodexTrustConfigIfUnchanged(tomlPath, snapshot, expected)) {
    console.warn('[codex-trust-grant] config changed during RPC; stale rollback skipped')
  }
}
