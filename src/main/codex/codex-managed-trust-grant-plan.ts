import {
  readCodexTrustGrantLedgerHomeMatchingStamp,
  type CodexTrustGrantHost
} from './codex-trust-grant-host'
import type { CodexTrustGrantBinaryStamp } from './codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

export type CodexManagedTrustGrantPlan = {
  /** Host-visible home (UNC for WSL), used for ledger keys and config reads. */
  runtimeHomePath: string
  /** Host-visible, including for guest runtimes. */
  tomlPath: string
  managedCommand: string
  managedEntries: readonly CodexTrustEntry[]
  host: CodexTrustGrantHost
}

export type ExpectedManagedEntry = {
  entry: CodexTrustEntry
  normalizedKey: string
  signature: string
}

export function buildExpectedEntries(plan: CodexManagedTrustGrantPlan): ExpectedManagedEntry[] {
  return plan.managedEntries.map((entry) => ({
    entry,
    normalizedKey: normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
    signature: getCodexHookTrustSignature(entry)
  }))
}

// Clear conflicting Windows separator aliases before canonical RPC writes.
// Managed homes restore fallback trust on failure; never clear matching ~/.codex records here.
export function removeSelfComputedTrustBeforeGrant(plan: CodexManagedTrustGrantPlan): void {
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

/** Reuse grants only while the binary, hook identity and current config match. */
export function findLedgerGrant(
  plan: CodexManagedTrustGrantPlan,
  expected: ExpectedManagedEntry[],
  currentStamp: CodexTrustGrantBinaryStamp | null
): CodexTrustEntry[] | null {
  const home = readCodexTrustGrantLedgerHomeMatchingStamp(plan.runtimeHomePath, currentStamp)
  if (!home) {
    return null
  }
  let trustStates: ReturnType<typeof readHookTrustEntries>
  try {
    trustStates = readHookTrustEntries(plan.tomlPath)
  } catch {
    return null
  }
  const entries: CodexTrustEntry[] = []
  for (const { entry, normalizedKey, signature } of expected) {
    const recorded = home.entries[normalizedKey]
    if (!recorded || recorded.signature !== signature) {
      return null
    }
    if (trustStates.get(normalizedKey)?.trustedHash !== recorded.trustedHash) {
      return null
    }
    entries.push({ ...entry, trustedHash: recorded.trustedHash })
  }
  return entries
}
