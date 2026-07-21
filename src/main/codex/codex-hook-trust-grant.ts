import {
  isCodexAppServerUnsupportedError,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import { runCodexHookTrustGrantSessionSync } from './codex-app-server-grant-bridge'
import {
  codexAppServerCapabilityCache,
  getCodexAppServerHostKey
} from './codex-app-server-capability-cache'
import {
  writeCodexTrustGrantLedgerHome,
  type CodexTrustGrantBinaryStamp,
  type CodexTrustGrantLedgerEntry
} from './codex-trust-grant-ledger'
import {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { captureCodexTrustConfig, restoreCodexTrustConfig } from './codex-trust-config-rollback'
import {
  readCodexTrustGrantLedgerHomeMatchingStamp,
  resolveCodexTrustGrantHost,
  type CodexTrustGrantHost
} from './codex-trust-grant-host'

// Why: a transiently hung app-server must not block launch prep on every pane.
// The legacy lane remains available while a short, host-scoped cooldown runs.
export const CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS = 5 * 60_000

/** Ops escape hatch (not a setting): forces the unchanged fallback lane. */
const DISABLE_ENV_FLAG = 'ORCA_DISABLE_CODEX_TRUST_RPC'

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
  /** Match a pane where CODEX_HOME is absent instead of an explicit managed home. */
  useDefaultCodexHome?: boolean
}

export type CodexTrustGrantFallbackReason =
  | 'disabled'
  | 'no-managed-entries'
  | 'unsupported'
  | 'unsupported-cached'
  | 'verify-failed'
  | 'retry-cached'
  | 'error'

export type CodexManagedTrustGrantOutcome =
  | { lane: 'rpc'; entries: CodexTrustEntry[] }
  | { lane: 'fallback'; reason: CodexTrustGrantFallbackReason }

export type CodexTrustGrantDiagnostics = {
  granted: number
  ledgerHits: number
  fellBack: number
  verifyFailed: number
  lastFallbackReason: CodexTrustGrantFallbackReason | null
}

const diagnostics: CodexTrustGrantDiagnostics = {
  granted: 0,
  ledgerHits: 0,
  fellBack: 0,
  verifyFailed: 0,
  lastFallbackReason: null
}
const transientRetryAfterByHost = new Map<string, number>()

export function getCodexTrustGrantDiagnostics(): CodexTrustGrantDiagnostics {
  return { ...diagnostics }
}

type CodexTrustGrantTelemetry = (event: {
  outcome: 'granted' | 'fallback' | 'verify_failed'
  hostKind: 'native' | 'wsl'
  reason?: CodexTrustGrantFallbackReason
}) => void

// Why: hook-service is bundled into plain-node CLI entries where electron
// (and therefore the telemetry client) cannot load; the Electron main process
// injects the tracker at startup instead of a static import.
let telemetry: CodexTrustGrantTelemetry = () => {}

export function setCodexTrustGrantTelemetry(tracker: CodexTrustGrantTelemetry): void {
  telemetry = tracker
}

function emitTelemetry(event: Parameters<CodexTrustGrantTelemetry>[0]): void {
  try {
    telemetry(event)
  } catch (error) {
    // Why: observability must never turn a verified grant into fallback or
    // violate this launch-prep API's no-throw contract.
    console.warn('[codex-trust-grant] failed to emit telemetry', error)
  }
}

type GrantSessionRunnerSync = (
  request: CodexHookTrustGrantRequest
) => CodexHookTrustGrantSessionResult

let runSessionSync: GrantSessionRunnerSync = runCodexHookTrustGrantSessionSync

function fallback(
  plan: CodexManagedTrustGrantPlan,
  reason: CodexTrustGrantFallbackReason,
  detail?: unknown
): CodexManagedTrustGrantOutcome {
  diagnostics.fellBack += 1
  diagnostics.lastFallbackReason = reason
  if (reason === 'verify-failed') {
    diagnostics.verifyFailed += 1
  }
  console.warn(
    `[codex-trust-grant] falling back to self-computed trust (reason=${reason}, host=${plan.host.kind})`,
    detail ?? ''
  )
  emitTelemetry({
    outcome: reason === 'verify-failed' ? 'verify_failed' : 'fallback',
    hostKind: plan.host.kind,
    reason
  })
  return { lane: 'fallback', reason }
}

type ExpectedManagedEntry = {
  entry: CodexTrustEntry
  normalizedKey: string
  signature: string
}

function buildExpectedEntries(plan: CodexManagedTrustGrantPlan): ExpectedManagedEntry[] {
  return plan.managedEntries.map((entry) => ({
    entry,
    normalizedKey: normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
    signature: getCodexHookTrustSignature(entry)
  }))
}

function removeSelfComputedTrustBeforeGrant(plan: CodexManagedTrustGrantPlan): void {
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

function findLedgerGrant(
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

/**
 * Grants trust for Orca's managed Codex hooks through codex's own app-server
 * RPCs, verified by re-list. Returns the granted entries carrying Codex's
 * verbatim hashes, or a fallback marker — the caller then runs the previous
 * computeTrustedHash lane, byte-identical to the pre-RPC behavior. Never
 * throws: any unexpected failure is a fallback, because hook install is
 * best-effort launch prep.
 */
export function grantManagedCodexHookTrust(
  plan: CodexManagedTrustGrantPlan
): CodexManagedTrustGrantOutcome {
  try {
    if (process.env[DISABLE_ENV_FLAG] === '1') {
      return fallback(plan, 'disabled')
    }
    if (plan.managedEntries.length === 0) {
      return fallback(plan, 'no-managed-entries')
    }
    const expected = buildExpectedEntries(plan)
    const resolvedHost = resolveCodexTrustGrantHost(plan.host)
    const currentStamp = resolvedHost.binaryStamp
    const ledgerEntries = findLedgerGrant(plan, expected, currentStamp)
    if (ledgerEntries !== null) {
      diagnostics.ledgerHits += 1
      return { lane: 'rpc', entries: ledgerEntries }
    }

    const hostKey = getCodexAppServerHostKey(plan.host)
    if (!codexAppServerCapabilityCache.shouldTry(hostKey)) {
      return fallback(plan, 'unsupported-cached')
    }
    const transientRetryAfter = transientRetryAfterByHost.get(hostKey)
    if (transientRetryAfter !== undefined) {
      if (Date.now() < transientRetryAfter) {
        return fallback(plan, 'retry-cached')
      }
      transientRetryAfterByHost.delete(hostKey)
    }

    const startedAtMs = Date.now()
    // Why: the RPC may rewrite config.toml before a later RPC fails. Restore
    // its exact pre-session bytes before the legacy lane runs so every fallback
    // has the same input and output as the pre-RPC implementation.
    const configSnapshot = captureCodexTrustConfig(plan.tomlPath)
    let result: CodexHookTrustGrantSessionResult
    try {
      // Why: Windows fallback writes equivalent separator variants that Codex's
      // canonical RPC key may not overwrite, leaving conflicting logical trust.
      removeSelfComputedTrustBeforeGrant(plan)
      result = runSessionSync(
        resolvedHost.buildRequest({
          runtimeHomePath: plan.runtimeHomePath,
          managedCommand: plan.managedCommand,
          expectedTrustKeys: expected.map(({ normalizedKey }) => normalizedKey),
          useDefaultCodexHome: plan.useDefaultCodexHome
        })
      )
    } catch (error) {
      restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
      if (isCodexAppServerUnsupportedError(error)) {
        transientRetryAfterByHost.delete(hostKey)
        codexAppServerCapabilityCache.rememberUnsupported(hostKey)
        return fallback(plan, 'unsupported', error)
      }
      transientRetryAfterByHost.set(
        hostKey,
        Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
      )
      return fallback(plan, 'error', error)
    }
    // Why: the RPC surface answered, even if our entries were not verifiable —
    // remember support so a later drift event retries the preferred lane.
    codexAppServerCapabilityCache.rememberSupported(hostKey)
    if (result.outcome === 'verify-failed') {
      restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
      transientRetryAfterByHost.set(
        hostKey,
        Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
      )
      return fallback(plan, 'verify-failed', result.reason)
    }

    const byNormalizedKey = new Map(expected.map((item) => [item.normalizedKey, item]))
    const seenNormalizedKeys = new Set<string>()
    const grantedEntries: CodexTrustEntry[] = []
    const ledgerRecord: Record<string, CodexTrustGrantLedgerEntry> = {}
    for (const granted of result.entries) {
      const match = byNormalizedKey.get(granted.normalizedKey)
      if (!match) {
        restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
        transientRetryAfterByHost.set(
          hostKey,
          Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
        )
        return fallback(plan, 'verify-failed', `unexpected granted key ${granted.key}`)
      }
      if (seenNormalizedKeys.has(granted.normalizedKey)) {
        restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
        transientRetryAfterByHost.set(
          hostKey,
          Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
        )
        return fallback(plan, 'verify-failed', `duplicate granted key ${granted.key}`)
      }
      seenNormalizedKeys.add(granted.normalizedKey)
      grantedEntries.push({ ...match.entry, trustedHash: granted.trustedHash })
      ledgerRecord[granted.normalizedKey] = {
        signature: match.signature,
        trustedHash: granted.trustedHash
      }
    }
    if (seenNormalizedKeys.size !== expected.length) {
      restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
      transientRetryAfterByHost.set(
        hostKey,
        Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
      )
      return fallback(plan, 'verify-failed', 'granted entry set did not cover expected entries')
    }
    transientRetryAfterByHost.delete(hostKey)
    try {
      writeCodexTrustGrantLedgerHome(plan.runtimeHomePath, {
        binary: currentStamp,
        entries: ledgerRecord
      })
    } catch (error) {
      // Why: a ledger write failure only costs an extra session next launch.
      console.warn('[codex-trust-grant] failed to persist grant ledger', error)
    }
    diagnostics.granted += 1
    console.log(
      `[codex-trust-grant] granted ${grantedEntries.length} managed hook entries via codex app-server ` +
        `(host=${plan.host.kind}, wrote=${result.wroteTrust}, ${Date.now() - startedAtMs}ms)`
    )
    emitTelemetry({ outcome: 'granted', hostKind: plan.host.kind })
    return { lane: 'rpc', entries: grantedEntries }
  } catch (error) {
    return fallback(plan, 'error', error)
  }
}

export const _internals = {
  setGrantSessionRunnerSync(runner: GrantSessionRunnerSync | null): void {
    runSessionSync = runner ?? runCodexHookTrustGrantSessionSync
  },
  resetDiagnostics(): void {
    diagnostics.granted = 0
    diagnostics.ledgerHits = 0
    diagnostics.fellBack = 0
    diagnostics.verifyFailed = 0
    diagnostics.lastFallbackReason = null
    transientRetryAfterByHost.clear()
  }
}
