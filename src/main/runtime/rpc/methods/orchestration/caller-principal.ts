/**
 * ONE caller resolver for the orchestration RPC boundary: every credential form in, one resolved
 * shape out. Methods consume the shape whole and never inspect the principal's kind — per-method
 * `if (params.agentSessionId)` branches are the defect class this module exists to prevent.
 *
 * Credential tiers: identity requires possession of an UNGUESSABLE BEARER — a `term_` handle, a
 * `structworker_` handle, or an attested pane key with a random leaf. A declared `agentSessionId`
 * or `runtimeFence` NEVER authenticates on its own: session ids are public (tab ids embed them in
 * plain text) and fences are small integers, so both are corroboration only. Deriving a session
 * principal from a pane key is legal exactly once — PR 1's one-time server-side backfill and
 * dual-write over rows the host itself wrote — and never at request time.
 */
import { z } from 'zod'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration-compatibility-evidence'
import {
  formatOrchestrationPrincipal,
  type OrchestrationPrincipal
} from '../../../../../shared/orchestration-principal'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { RunCoordinatorBinding } from '../../../orchestration/types'
import type { WorkerTerminalHostScope } from '../../../orchestration/worker-terminal-process-liveness'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../../orca-runtime'
import {
  readStructuredAgentSessionRecord,
  resolveStructuredWorkerIdentity
} from '../../../structured-worker-authority'
import {
  isStructuredWorkerHandle,
  structuredWorkerHostScope,
  structuredWorkerRecordIsCurrent
} from '../../../structured-worker-identity'
import { OptionalString } from '../../schemas'
import { assertCallerHandleMatchesEvidence, resolveOrchestrationCaller } from './runs/run-scope'

/**
 * Shared wire fragment for methods that accept orchestration caller credentials. `runtimeFence`
 * uses `.min(0)` deliberately: the lease validator allows fence 0, so `.positive()` would lock
 * out freshly leased sessions.
 */
export const orchestrationCallerParamFields = {
  from: OptionalString,
  agentSessionId: OptionalString,
  runtimeFence: z.number().int().min(0).optional()
}

export type OrchestrationCallerCredentials = {
  /** Terminal handle or structured-worker handle. Accepted forever; never required. */
  from?: string
  /** Caller-declared pane key (resolveRunScope's callerPaneKey passthrough). */
  paneKey?: string
  /**
   * Corroboration ONLY, never a credential: session ids are guessable (embedded in tab ids)
   * and fences are small integers. Session-kind resolution requires an unguessable bearer
   * (a structworker handle in `from` today; a host-baked session bearer in later PRs).
   */
  agentSessionId?: string
  runtimeFence?: number
  evidence?: OrchestrationCompatibilityEvidence
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
  /** Same contract as resolveOrchestrationCaller's requireStablePane. */
  requireBindableCaller?: boolean
  /** Same contract & warning as evidenceAssertedByCaller; pairs with attestDeclaredCaller(). */
  deferEvidenceAssertion?: boolean
}

export type ResolvedOrchestrationCaller = Readonly<{
  principal: OrchestrationPrincipal
  /** Canonical `pane:<paneKey>` / `session:<sessionId>`. */
  principalId: string
  /** pane: processIncarnation (null when unproven); session: String(lease.runtimeFence). Opaque. */
  ownerGeneration: string | null
  hostScope: WorkerTerminalHostScope | null
  workspaceId: string | null
  /**
   * Live proven caller: pane = callerAuthority matches handle+pane. Session-kind is always false:
   * hook attestation can never mint authority for a structured handle (no PTY, no launch token),
   * so takeover-legacy must keep failing for that form.
   */
  attested: boolean
  /** Opaque carrier for DB writers & mail routing; methods pass it through whole. */
  binding: RunCoordinatorBinding
  /** Mailbox waiter keys to cancel on rebind; methods iterate, never inspect. */
  waiterHandles: readonly string[]
  /** Deferred half of the attestation when deferEvidenceAssertion was set; no-op otherwise. */
  attestDeclaredCaller(): void
}>

// Overloaded like resolveOrchestrationCaller: with requireBindableCaller:true the caller is
// non-null or the resolver throws; otherwise a pane caller with no stable pane resolves to null.
export function resolveCallerPrincipal(
  runtime: OrcaRuntimeService,
  credentials: OrchestrationCallerCredentials & { requireBindableCaller: true }
): ResolvedOrchestrationCaller
export function resolveCallerPrincipal(
  runtime: OrcaRuntimeService,
  credentials: OrchestrationCallerCredentials
): ResolvedOrchestrationCaller | null
export function resolveCallerPrincipal(
  runtime: OrcaRuntimeService,
  credentials: OrchestrationCallerCredentials
): ResolvedOrchestrationCaller | null {
  if (credentials.from && isStructuredWorkerHandle(credentials.from)) {
    return resolveSessionPrincipal(runtime, credentials, credentials.from)
  }
  if (credentials.from) {
    return resolvePanePrincipal(runtime, credentials, credentials.from)
  }
  if (credentials.agentSessionId) {
    // Deliberate: session ids are public, so accepting a declared one would let any RPC caller
    // impersonate any native session.
    throw new OrchestrationError(
      'consumer_fenced',
      "A declared session id is not a credential. Call with the session's issued handle."
    )
  }
  throw new OrchestrationError(
    'invalid_argument',
    'Missing coordinator identity: pass --from or an agent session credential.'
  )
}

/** Immediate unless deferred; the deferred half preserves run-use's resolve→takeover→attest order. */
function evidenceAttestation(
  runtime: OrcaRuntimeService,
  from: string,
  credentials: OrchestrationCallerCredentials
): () => void {
  if (!credentials.deferEvidenceAssertion) {
    assertCallerHandleMatchesEvidence(runtime, from, credentials.evidence)
    return () => {}
  }
  return () => assertCallerHandleMatchesEvidence(runtime, from, credentials.evidence)
}

function resolveSessionPrincipal(
  runtime: OrcaRuntimeService,
  credentials: OrchestrationCallerCredentials,
  from: string
): ResolvedOrchestrationCaller {
  const attestDeclaredCaller = evidenceAttestation(runtime, from, credentials)
  const identity = resolveStructuredWorkerIdentity(from, runtime.getOrchestrationDb())
  const record = identity ? readStructuredAgentSessionRecord(identity.sessionId) : null
  if (
    !identity ||
    !record ||
    !structuredWorkerRecordIsCurrent(record) ||
    record.lease.claimStatus !== 'live' ||
    record.lease.unreconciled ||
    record.lease.handoffStage !== null ||
    // Declared values corroborate the bearer: a mismatch means yesterday's identity.
    (credentials.agentSessionId !== undefined &&
      credentials.agentSessionId !== identity.sessionId) ||
    (credentials.runtimeFence !== undefined &&
      credentials.runtimeFence !== record.lease.runtimeFence)
  ) {
    throw new OrchestrationError('consumer_fenced', 'The native session lease is not current.')
  }
  const principal: OrchestrationPrincipal = { kind: 'session', sessionId: identity.sessionId }
  const principalId = formatOrchestrationPrincipal(principal)
  return {
    principal,
    principalId,
    ownerGeneration: String(record.lease.runtimeFence),
    hostScope: structuredWorkerHostScope(record.location),
    workspaceId: record.location.workspaceId,
    attested: false,
    // Handle + minted pane key keep dual-write and mail routing byte-identical with today.
    binding: { principalId, terminalHandle: from, paneKey: identity.paneKey },
    waiterHandles: [from],
    attestDeclaredCaller
  }
}

function resolvePanePrincipal(
  runtime: OrcaRuntimeService,
  credentials: OrchestrationCallerCredentials,
  from: string
): ResolvedOrchestrationCaller | null {
  if (credentials.agentSessionId !== undefined) {
    // A pane bearer may not claim to be a session.
    throw new OrchestrationError(
      'consumer_fenced',
      'A pane caller cannot declare an agent session identity.'
    )
  }
  const resolved = resolveOrchestrationCaller(runtime, {
    callerTerminalHandle: from,
    callerEvidence: credentials.evidence,
    callerAuthority: credentials.callerAuthority,
    evidenceAssertedByCaller: credentials.deferEvidenceAssertion,
    requireStablePane:
      credentials.requireBindableCaller === true && credentials.paneKey === undefined
  })
  const callerAuthority = credentials.callerAuthority
  // Attested authority wins; a declared pane key slots ahead of the live-pane fallback only
  // (resolveRunScope's callerPaneKey contract).
  const paneKey =
    callerAuthority?.terminalHandle === from ? resolved : (credentials.paneKey ?? resolved)
  if (!paneKey) {
    return null
  }
  const principal: OrchestrationPrincipal = { kind: 'pane', paneKey }
  const principalId = formatOrchestrationPrincipal(principal)
  let authority: ReturnType<OrcaRuntimeService['getOrchestrationDispatchAuthority']> = null
  try {
    authority = runtime.getOrchestrationDispatchAuthority(from)
  } catch {
    authority = null
  }
  return {
    principal,
    principalId,
    ownerGeneration: authority?.processIncarnation ?? null,
    hostScope: authority?.hostScope ?? null,
    workspaceId: authority?.worktreeId ?? null,
    attested: callerAuthority?.terminalHandle === from && callerAuthority?.paneKey === paneKey,
    binding: { principalId, terminalHandle: from, paneKey },
    waiterHandles: [from],
    attestDeclaredCaller: credentials.deferEvidenceAssertion
      ? () => assertCallerHandleMatchesEvidence(runtime, from, credentials.evidence)
      : () => {}
  }
}
