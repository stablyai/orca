import type { CodexTrustGrantTelemetryLane } from './codex-trust-grant-telemetry'
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
  /** Host-visible runtime home path (UNC for WSL) — ledger key + config reads. */
  runtimeHomePath: string
  /** Host-visible config.toml path holding the trust entries. */
  tomlPath: string
  /** Exact command string written to the managed hooks.json entries. */
  managedCommand: string
  /** Managed trust identities Orca just wrote (no trustedHash). */
  managedEntries: readonly CodexTrustEntry[]
  host: CodexTrustGrantHost
  telemetryLane: CodexTrustGrantTelemetryLane
  /** Match a pane where CODEX_HOME is absent instead of an explicit managed home. */
  useDefaultCodexHome?: boolean
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

/** Windows fallback writes equivalent separator variants that Codex's canonical
 *  RPC key may not overwrite, leaving conflicting logical trust behind. */
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

/** Entries a prior grant already recorded for this exact binary and config
 *  state, or null when the RPC session has to run again. */
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
