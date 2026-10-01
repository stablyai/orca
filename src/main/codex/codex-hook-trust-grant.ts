import {
  isCodexAppServerUnsupportedError,
  runCodexHookTrustGrantSession,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import {
  classifyCodexTrustGrantError,
  emitCodexTrustGrantTelemetry,
  type CodexTrustGrantErrorClass,
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
import {
  resolveCodexTrustGrantHost,
  type ResolvedCodexTrustGrantHost
} from './codex-trust-grant-host'
import {
  buildExpectedEntries,
  findLedgerGrant,
  type CodexManagedTrustGrantPlan,
  type ExpectedManagedEntry
} from './codex-managed-trust-grant-plan'
import { isCodexStateDbBackfillPending } from './codex-state-db'
import {
  clearCodexTrustGrantCooldown,
  countCodexTrustGrantCooldowns,
  isCodexTrustGrantCoolingDown,
  resetCodexTrustGrantCooldowns,
  startCodexTrustGrantCooldown
} from './codex-trust-grant-cooldown'

export { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-trust-grant-cooldown'

// Why: a cold `codex app-server` on a loaded Mac took over 10 s; a background
// grant blocks no launch, so it can wait for one. The session's own kill timer
// bounds the whole grant: everything before it is synchronous on native.
export const CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS = 30_000

/** Ops escape hatch (not a setting): forces the fallback lane for every trust grant. */
const DISABLE_ENV_FLAG = 'ORCA_DISABLE_CODEX_TRUST_RPC'

export type { CodexManagedTrustGrantPlan }
export type { CodexTrustGrantFallbackReason, CodexTrustGrantTelemetryLane }

export type CodexManagedTrustGrantOutcome =
  | { lane: 'rpc'; entries: CodexTrustEntry[] }
  | {
      lane: 'fallback'
      reason: CodexTrustGrantFallbackReason
      errorClass?: CodexTrustGrantErrorClass
    }

const diagnostics = {
  granted: 0,
  ledgerHits: 0,
  fellBack: 0,
  verifyFailed: 0,
  lastFallbackReason: null as CodexTrustGrantFallbackReason | null
}
export type CodexTrustGrantDiagnostics = typeof diagnostics

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
  const errorClass = reason === 'error' ? classifyCodexTrustGrantError(detail) : undefined
  console.warn(
    `[codex-trust-grant] falling back to self-computed trust (reason=${reason}, host=${plan.host.kind})`,
    detail ?? ''
  )
  emitCodexTrustGrantTelemetry({
    outcome: reason === 'verify-failed' ? 'verify_failed' : 'fallback',
    hostKind: plan.host.kind,
    lane: plan.telemetryLane,
    reason,
    ...(errorClass !== undefined ? { errorClass } : {}),
    ...(verifyClass !== undefined ? { verifyClass } : {})
  })
  return { lane: 'fallback', reason, ...(errorClass !== undefined ? { errorClass } : {}) }
}

type GrantAttempt = {
  plan: CodexManagedTrustGrantPlan
  expected: ExpectedManagedEntry[]
  hostKey: CodexAppServerHostKey
  currentStamp: CodexTrustGrantBinaryStamp | null
  startedAtMs: number
}

/** Post-session verification, ledger persistence and telemetry. Never throws for
 *  a verify failure — every rejection is a fallback. */
function completeGrant(
  attempt: GrantAttempt,
  result: CodexHookTrustGrantSessionResult
): CodexManagedTrustGrantOutcome {
  const { plan, expected, hostKey } = attempt
  const rejectGrant = (
    detail: unknown,
    verifyClass: CodexTrustGrantVerifyClass
  ): CodexManagedTrustGrantOutcome => {
    if (!plan.background) {
      startCodexTrustGrantCooldown(hostKey)
    }
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
  clearCodexTrustGrantCooldown(hostKey)
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
  hostKey: CodexAppServerHostKey,
  beforeSession: (() => void) | undefined
): Promise<CodexManagedTrustGrantOutcome> {
  // Why no config.toml restore on failure: the session writes trust only at
  // Orca's own keys, bound to Orca's command by its hash, and each caller settles
  // those keys itself. A restore would undo anything saved meanwhile.
  const attempt: GrantAttempt = {
    plan,
    expected,
    hostKey,
    currentStamp: resolvedHost.binaryStamp,
    startedAtMs: Date.now()
  }
  let unsupportedError: unknown
  // Why unshared: a launch's inline grant must not wait behind a background
  // session that may take a cold app-server's full budget.
  const runWithCapability = plan.background
    ? codexAppServerCapabilityCache.runUnshared.bind(codexAppServerCapabilityCache)
    : codexAppServerCapabilityCache.runWithFallback.bind(codexAppServerCapabilityCache)
  try {
    return await runWithCapability(
      hostKey,
      async () => {
        beforeSession?.()
        return completeGrant(
          attempt,
          await runSession(
            resolvedHost.buildRequest({
              runtimeHomePath: plan.runtimeHomePath,
              managedCommand: plan.managedCommand,
              expectedTrustKeys: expected.map(({ normalizedKey }) => normalizedKey),
              useDefaultCodexHome: plan.useDefaultCodexHome,
              ...(plan.background ? { timeoutMs: CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS } : {})
            })
          )
        )
      },
      async () => {
        if (unsupportedError === undefined) {
          // Why: a concurrent launch's probe proved the surface missing while
          // this one waited behind it.
          return fallback(plan, 'unsupported-cached')
        }
        clearCodexTrustGrantCooldown(hostKey)
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
    if (!plan.background) {
      startCodexTrustGrantCooldown(hostKey)
    }
    return fallback(plan, 'error', error)
  }
}

/**
 * The session-free half of a grant: Codex's recorded hashes for these entries
 * when the ledger shows they are still current, or null.
 */
export async function findCurrentManagedCodexHookTrust(
  plan: CodexManagedTrustGrantPlan
): Promise<CodexTrustEntry[] | null> {
  try {
    if (process.env[DISABLE_ENV_FLAG] === '1' || plan.managedEntries.length === 0) {
      return null
    }
    const resolvedHost = await resolveCodexTrustGrantHost(plan.host)
    return findLedgerGrant(plan, buildExpectedEntries(plan), resolvedHost.binaryStamp)
  } catch {
    return null
  }
}

/**
 * Grants trust for Orca's managed Codex hooks through codex's own app-server
 * RPCs, verified by re-list. Returns the granted entries carrying Codex's
 * verbatim hashes, or a fallback marker — a managed-home caller then writes
 * computeTrustedHash trust, and the real-home caller withdraws its entry. Never
 * throws: any unexpected failure is a fallback, because hook install is
 * best-effort launch prep. `beforeSession` runs, under the caller's lane, only
 * when a session will run: never on a ledger hit, cooldown or cached fallback.
 */
export async function grantManagedCodexHookTrust(
  plan: CodexManagedTrustGrantPlan,
  beforeSession?: () => void
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
    if (!plan.background && isCodexTrustGrantCoolingDown(hostKey)) {
      return fallback(plan, 'retry-cached')
    }
    // Why no lane across the session: Codex writes its own records, and a held
    // lane would queue every launch's config.toml write behind a cold app-server.
    return await runGrantAttempt(plan, expected, resolvedHost, hostKey, beforeSession)
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
    resetCodexTrustGrantCooldowns()
  },
  transientCooldownCountForTests(): number {
    return countCodexTrustGrantCooldowns()
  }
}
