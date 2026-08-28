import {
  isCodexAppServerUnsupportedError,
  runCodexHookTrustGrantSession,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import {
  classifyCodexTrustGrantError,
  emitCodexTrustGrantTelemetry,
  type CodexTrustGrantFallbackReason,
  type CodexTrustGrantTelemetryLane,
  type CodexTrustGrantVerifyClass
} from './codex-trust-grant-telemetry'
import {
  codexAppServerCapabilityCache,
  getCodexAppServerHostKey,
  type CodexAppServerHostKey
} from './codex-app-server-capability-cache'
import {
  writeCodexTrustGrantLedgerHome,
  type CodexTrustGrantBinaryStamp,
  type CodexTrustGrantLedgerEntry
} from './codex-trust-grant-ledger'
import type { CodexTrustEntry } from './config-toml-trust'
import { captureCodexTrustConfig, restoreCodexTrustConfig } from './codex-trust-config-rollback'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  resolveCodexTrustGrantHost,
  type ResolvedCodexTrustGrantHost
} from './codex-trust-grant-host'
import {
  buildExpectedEntries,
  findLedgerGrant,
  removeSelfComputedTrustBeforeGrant,
  type CodexManagedTrustGrantPlan,
  type ExpectedManagedEntry
} from './codex-managed-trust-grant-plan'
import { isCodexStateDbBackfillPending } from './codex-state-db'

// Why: a transiently hung app-server must not block launch prep on every pane.
// The legacy lane remains available while a short, host-scoped cooldown runs.
export const CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS = 5 * 60_000

/**
 * Ops escape hatch (not a setting): forces the unchanged fallback lane for the
 * *managed* grant only.
 *
 * Scope, because the name reads broader than it is: the real-home rebase
 * (`mutateRealHomeHooksPreservingUserTrust`) still runs its own inspect/repair
 * app-server sessions when Orca's insertion shifts a user's hook positions, and
 * does not read this flag. That is unchanged from before the grant went async —
 * those sessions simply used to block the main thread instead. Widening the flag
 * to cover the rebase is a follow-up, not something this constant already does.
 */
const DISABLE_ENV_FLAG = 'ORCA_DISABLE_CODEX_TRUST_RPC'

export type { CodexManagedTrustGrantPlan }
export type { CodexTrustGrantFallbackReason, CodexTrustGrantTelemetryLane }

export type CodexManagedTrustGrantOutcome =
  | { lane: 'rpc'; entries: CodexTrustEntry[] }
  | { lane: 'fallback'; reason: CodexTrustGrantFallbackReason }

const diagnostics = {
  granted: 0,
  ledgerHits: 0,
  fellBack: 0,
  verifyFailed: 0,
  lastFallbackReason: null as CodexTrustGrantFallbackReason | null
}
export type CodexTrustGrantDiagnostics = typeof diagnostics
const transientRetryAfterByHost = new Map<string, number>()

export const getCodexTrustGrantDiagnostics = (): CodexTrustGrantDiagnostics => ({ ...diagnostics })

type GrantSessionRunner = (
  request: CodexHookTrustGrantRequest
) => Promise<CodexHookTrustGrantSessionResult>

// Why (#16441): the session runs in-process on the main thread's event loop.
// It used to be forked through spawnSync purely to donate an event loop to a
// deliberately-blocked parent, which froze the window for the whole deadline.
let runSession: GrantSessionRunner = runCodexHookTrustGrantSession

function fallback(
  plan: CodexManagedTrustGrantPlan,
  reason: CodexTrustGrantFallbackReason,
  detail?: unknown,
  verifyClass?: CodexTrustGrantVerifyClass
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
  emitCodexTrustGrantTelemetry({
    outcome: reason === 'verify-failed' ? 'verify_failed' : 'fallback',
    hostKind: plan.host.kind,
    lane: plan.telemetryLane,
    reason,
    ...(reason === 'error' ? { errorClass: classifyCodexTrustGrantError(detail) } : {}),
    ...(verifyClass !== undefined ? { verifyClass } : {})
  })
  return { lane: 'fallback', reason }
}

function startTransientCooldown(hostKey: CodexAppServerHostKey): void {
  transientRetryAfterByHost.set(hostKey, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
}

type GrantAttempt = {
  plan: CodexManagedTrustGrantPlan
  expected: ExpectedManagedEntry[]
  hostKey: CodexAppServerHostKey
  currentStamp: CodexTrustGrantBinaryStamp | null
  configSnapshot: ReturnType<typeof captureCodexTrustConfig>
  startedAtMs: number
}

/** Post-session verification, ledger persistence and telemetry. Never throws for
 *  a verify failure — every rejection is a rolled-back fallback. */
function completeGrant(
  attempt: GrantAttempt,
  result: CodexHookTrustGrantSessionResult
): CodexManagedTrustGrantOutcome {
  const { plan, expected, hostKey, configSnapshot } = attempt
  const rejectGrant = (
    detail: unknown,
    verifyClass: CodexTrustGrantVerifyClass
  ): CodexManagedTrustGrantOutcome => {
    restoreCodexTrustConfig(plan.tomlPath, configSnapshot)
    startTransientCooldown(hostKey)
    return fallback(plan, 'verify-failed', detail, verifyClass)
  }
  if (result.outcome === 'verify-failed') {
    return rejectGrant(result.reason, result.reasonClass)
  }

  const byNormalizedKey = new Map(expected.map((item) => [item.normalizedKey, item]))
  const seenNormalizedKeys = new Set<string>()
  const grantedEntries: CodexTrustEntry[] = []
  const ledgerRecord: Record<string, CodexTrustGrantLedgerEntry> = {}
  for (const granted of result.entries) {
    const match = byNormalizedKey.get(granted.normalizedKey)
    if (!match) {
      return rejectGrant(`unexpected granted key ${granted.key}`, 'unexpected-key')
    }
    if (seenNormalizedKeys.has(granted.normalizedKey)) {
      return rejectGrant(`duplicate granted key ${granted.key}`, 'duplicate-key')
    }
    seenNormalizedKeys.add(granted.normalizedKey)
    grantedEntries.push({ ...match.entry, trustedHash: granted.trustedHash })
    ledgerRecord[granted.normalizedKey] = {
      signature: match.signature,
      trustedHash: granted.trustedHash
    }
  }
  if (seenNormalizedKeys.size !== expected.length) {
    return rejectGrant('granted entry set did not cover expected entries', 'coverage')
  }
  transientRetryAfterByHost.delete(hostKey)
  try {
    writeCodexTrustGrantLedgerHome(plan.runtimeHomePath, {
      binary: attempt.currentStamp,
      entries: ledgerRecord
    })
  } catch (error) {
    // Why: a ledger write failure only costs an extra session next launch.
    console.warn('[codex-trust-grant] failed to persist grant ledger', error)
  }
  diagnostics.granted += 1
  console.log(
    `[codex-trust-grant] granted ${grantedEntries.length} managed hook entries via codex app-server ` +
      `(host=${plan.host.kind}, wrote=${result.wroteTrust}, ${Date.now() - attempt.startedAtMs}ms)`
  )
  emitCodexTrustGrantTelemetry({
    outcome: 'granted',
    hostKind: plan.host.kind,
    lane: plan.telemetryLane
  })
  return { lane: 'rpc', entries: grantedEntries }
}

async function runGrantAttempt(
  plan: CodexManagedTrustGrantPlan,
  expected: ExpectedManagedEntry[],
  resolvedHost: ResolvedCodexTrustGrantHost,
  hostKey: CodexAppServerHostKey
): Promise<CodexManagedTrustGrantOutcome> {
  // Why: the RPC may rewrite config.toml before a later RPC fails. Restore its
  // exact pre-session bytes before the legacy lane runs so every fallback has
  // the same input and output as the pre-RPC implementation.
  const attempt: GrantAttempt = {
    plan,
    expected,
    hostKey,
    currentStamp: resolvedHost.binaryStamp,
    configSnapshot: captureCodexTrustConfig(plan.tomlPath),
    startedAtMs: Date.now()
  }
  let unsupportedError: unknown
  try {
    return await codexAppServerCapabilityCache.runWithFallback(
      hostKey,
      async () => {
        removeSelfComputedTrustBeforeGrant(plan)
        return completeGrant(
          attempt,
          await runSession(
            resolvedHost.buildRequest({
              runtimeHomePath: plan.runtimeHomePath,
              managedCommand: plan.managedCommand,
              expectedTrustKeys: expected.map(({ normalizedKey }) => normalizedKey),
              useDefaultCodexHome: plan.useDefaultCodexHome
            })
          )
        )
      },
      async () => {
        if (unsupportedError === undefined) {
          // Why: a concurrent launch's probe proved the surface missing while
          // this one waited behind it; nothing was mutated, so nothing to undo.
          return fallback(plan, 'unsupported-cached')
        }
        restoreCodexTrustConfig(plan.tomlPath, attempt.configSnapshot)
        transientRetryAfterByHost.delete(hostKey)
        return fallback(plan, 'unsupported', unsupportedError)
      },
      (error) => {
        if (!isCodexAppServerUnsupportedError(error)) {
          return false
        }
        unsupportedError = error
        return true
      }
    )
  } catch (error) {
    restoreCodexTrustConfig(plan.tomlPath, attempt.configSnapshot)
    startTransientCooldown(hostKey)
    return fallback(plan, 'error', error)
  }
}

/**
 * Grants trust for Orca's managed Codex hooks through codex's own app-server
 * RPCs, verified by re-list. Returns the granted entries carrying Codex's
 * verbatim hashes, or a fallback marker — the caller then runs the previous
 * computeTrustedHash lane, byte-identical to the pre-RPC behavior. Never
 * throws: any unexpected failure is a fallback, because hook install is
 * best-effort launch prep.
 */
export async function grantManagedCodexHookTrust(
  plan: CodexManagedTrustGrantPlan
): Promise<CodexManagedTrustGrantOutcome> {
  try {
    if (process.env[DISABLE_ENV_FLAG] === '1') {
      return fallback(plan, 'disabled')
    }
    if (plan.managedEntries.length === 0) {
      return fallback(plan, 'no-managed-entries')
    }
    const expected = buildExpectedEntries(plan)
    const resolvedHost = await resolveCodexTrustGrantHost(plan.host)
    const ledgerEntries = findLedgerGrant(plan, expected, resolvedHost.binaryStamp)
    if (ledgerEntries !== null) {
      diagnostics.ledgerHits += 1
      return { lane: 'rpc', entries: ledgerEntries }
    }
    if (isCodexStateDbBackfillPending(plan.runtimeHomePath)) {
      // Why: a short trust RPC can refresh Codex's abandoned lease and strand every pane again.
      return fallback(plan, 'retry-cached')
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
    return await runExclusivelyForCodexTrustConfig(plan.tomlPath, () =>
      runGrantAttempt(plan, expected, resolvedHost, hostKey)
    )
  } catch (error) {
    return fallback(plan, 'error', error)
  }
}

export const _internals = {
  setGrantSessionRunner(runner: GrantSessionRunner | null): void {
    runSession = runner ?? runCodexHookTrustGrantSession
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
