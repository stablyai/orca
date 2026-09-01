// Host-private launch-operation bookkeeping for transactional worktree/agent
// creation (U4). Two structures, both main-only and excluded from every
// worktree/runtime/session client serialization:
//   1. pendingAgentLaunchSnapshotsByToken — the in-flight admitted launch's full
//      snapshot, launch token, canonical request-payload digest, idempotency
//      key, and operation id, keyed by launch token. The public WorktreeMeta
//      carries only {operationId, requestedAgent, priorFailureId?}; the snapshot
//      and token live here and never cross a client boundary. This map is
//      durably persisted to the host-private store so a terminal that outlives a
//      main crash still self-identifies by token during reconciliation.
//   2. recentAgentLaunchOperations — a bounded settled ledger (newest 16 per
//      scope, newest 256 scopes) that makes the create/retry mutation idempotent
//      across process restart. Entries carry digests, status, and ids only:
//      never raw command, paths, prompts, labels, token, or env.

import { createHash, randomBytes } from 'node:crypto'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentLaunchIntentKind, AgentLaunchReceipt } from '../../shared/agent-launch-contract'
import { principalKey, type AdmissionPrincipal } from './agent-launch-admission-store'

export const MAX_SETTLED_OPERATIONS_PER_SCOPE = 16

/** Global companion to the per-scope bound: scopes are minted per worktree/run/
 *  attempt and never reused, so capping only within a scope still lets the ledger
 *  — which EVERY durable mutation re-serializes in full — grow without limit. */
export const MAX_SETTLED_OPERATION_SCOPES = 256

export type SettledAgentLaunchStatus = 'launched' | 'failed' | 'forgotten'

/** In-flight admitted-launch record for one creation attempt. Durable but
 *  host-private; the snapshot and launchToken never enter a client DTO. */
export type PendingAgentLaunchSnapshot = {
  operationId: string
  idempotencyKey: string
  /** Owner bucket for reconciliation/ledger joins (worktree id, run id …). */
  scope: string
  clientMutationId: string | null
  payloadDigest: string
  launchToken: string
  /** The launch's original intent, preserved so a reconciled failure carries the
   *  true intent rather than assuming a default. */
  intent: AgentLaunchIntentKind
  /** Admission principal that holds this launch's capacity slot, persisted so a
   *  restart can rebuild the admission counters into the right cap bucket.
   *  Optional for pre-existing durable entries; absent rebuilds as local. */
  principal?: AdmissionPrincipal
  snapshot: AgentLaunchSnapshot
}

/** Settled outcome retained only for idempotency replay. Digests + references
 *  only; user-visible history lives in the owner records, never here. */
export type SettledAgentLaunchOperation = {
  operationId: string
  idempotencyKey: string
  scope: string
  payloadDigest: string
  status: SettledAgentLaunchStatus
  terminalId: string | null
  failureId: string | null
  settledAt: number
}

/** The two durable halves snapshotted together for the host-private sink: the
 *  in-flight private snapshots (argv/env/token — encrypted at rest) and the
 *  settled ledger (digests/ids — plaintext). The receipt map is intentionally
 *  excluded: receipts are live-terminal-scoped and never outlive a restart. */
export type AgentLaunchOperationStoreDurableState = {
  pending: readonly PendingAgentLaunchSnapshot[]
  settled: readonly SettledAgentLaunchOperation[]
}

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

/** Stable, key-sorted, undefined-dropping serialization so a canonical digest
 *  is insensitive to property order and absent optional fields. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => compareKeys(a, b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
}

/** Canonical hash of a request payload for same-key/different-payload conflict
 *  detection. The hash — never the raw payload — is what the ledger stores. */
export function canonicalPayloadDigest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

/** Idempotency scope key: stable authenticated principal + owner scope +
 *  client mutation id, hashed together. Survives restart and reconnect because
 *  every component is stable, never per-process or per-connection. */
export function agentLaunchIdempotencyKey(input: {
  principal: AdmissionPrincipal
  scope: string
  clientMutationId: string
}): string {
  return (
    createHash('sha256')
      // \u0000 escapes, not literal NUL bytes: identical hash input (keys stay
      // stable), but the source file remains text/diffable for git.
      .update(`${principalKey(input.principal)}\u0000${input.scope}\u0000${input.clientMutationId}`)
      .digest('hex')
  )
}

export function mintAgentLaunchOperationId(): string {
  return randomBytes(18).toString('base64url')
}

const CANONICAL_LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Canonical lowercase UUID form required of an external clientMutationId BEFORE
 *  any idempotency lookup or write, so a settled-ledger match after a crash is
 *  keyed on a stable, case-normalized value rather than a client's rendering. */
export function isCanonicalLowercaseUuid(value: string): boolean {
  return CANONICAL_LOWERCASE_UUID.test(value)
}

export class AgentLaunchOperationStore {
  private readonly pendingByToken = new Map<string, PendingAgentLaunchSnapshot>()
  // Tokens whose spawn is running in THIS process right now (beginPending →
  // settle). The reconciler must skip them: the PTY registers its launch token
  // only after spawn resolves, so mid-spawn the token looks absent and a full
  // re-list would false-settle spawn_failed while the real spawn succeeds.
  // Process-lifetime only — a rehydrated pending after a crash is NOT in-flight.
  private readonly inFlightSpawnTokens = new Set<string>()
  private readonly settledByScope = new Map<string, SettledAgentLaunchOperation[]>()
  // Main-private terminal -> receipt attribution recorded once the PTY registers.
  // A settled `launched` replay reissues this client-safe receipt without the
  // ledger ever holding a token; cleared on the terminal's exit reconciliation.
  private readonly receiptByTerminal = new Map<string, AgentLaunchReceipt>()
  // Host-private durable sink invoked after every mutation that changes durable
  // state (pending snapshots or the settled ledger), never for receipt changes.
  // Absent in unit tests and in U3 (in-memory); attached at boot by the host
  // persistence init once the user data dir is stable.
  private onDurableMutation: ((state: AgentLaunchOperationStoreDurableState) => void) | null = null

  /** Attach (or replace) the durable sink. Not called during rehydrate, so the
   *  load path never writes back the state it just read. */
  setDurablePersistence(sink: (state: AgentLaunchOperationStoreDurableState) => void): void {
    this.onDurableMutation = sink
  }

  /** Snapshot both durable halves together for the atomic file write. */
  durableState(): AgentLaunchOperationStoreDurableState {
    const settled: SettledAgentLaunchOperation[] = []
    for (const bucket of this.settledByScope.values()) {
      settled.push(...bucket)
    }
    return { pending: [...this.pendingByToken.values()], settled }
  }

  private persistDurable(): void {
    this.onDurableMutation?.(this.durableState())
  }

  recordRegisteredReceipt(terminalId: string, receipt: AgentLaunchReceipt): void {
    this.receiptByTerminal.set(terminalId, receipt)
  }

  registeredReceipt(terminalId: string): AgentLaunchReceipt | null {
    return this.receiptByTerminal.get(terminalId) ?? null
  }

  clearRegisteredReceipt(terminalId: string): boolean {
    return this.receiptByTerminal.delete(terminalId)
  }

  beginPending(entry: PendingAgentLaunchSnapshot): void {
    this.pendingByToken.set(entry.launchToken, entry)
    // beginPending is only ever called immediately before the spawn it guards,
    // so the token is in-flight until the transaction settles (clearPending).
    this.inFlightSpawnTokens.add(entry.launchToken)
    // Durable BEFORE the spawn/writer: a crash mid-spawn must leave the private
    // snapshot+token on disk so reconciliation can re-attribute the terminal.
    this.persistDurable()
  }

  /** Whether this process is actively spawning the token's PTY right now.
   *  Reconcile passes must not settle these (see inFlightSpawnTokens). */
  isSpawnInFlight(launchToken: string): boolean {
    return this.inFlightSpawnTokens.has(launchToken)
  }

  /** Release only the in-flight spawn guard, KEEPING the pending snapshot: the
   *  contact-lost arm of the spawn transaction ends this process's spawn attempt
   *  without settling the operation, so reconciliation must become able to
   *  resolve the retained pending on real host evidence. */
  releaseSpawnInFlight(launchToken: string): void {
    this.inFlightSpawnTokens.delete(launchToken)
  }

  getPending(launchToken: string): PendingAgentLaunchSnapshot | null {
    return this.pendingByToken.get(launchToken) ?? null
  }

  findPendingByIdempotencyKey(
    scope: string,
    idempotencyKey: string
  ): PendingAgentLaunchSnapshot | null {
    for (const entry of this.pendingByToken.values()) {
      if (entry.scope === scope && entry.idempotencyKey === idempotencyKey) {
        return entry
      }
    }
    return null
  }

  /** The in-flight snapshot for a scope, or null. A worktree/session scope carries
   *  at most one active launch (its public pending metadata is singular), so this
   *  is the source of the launch token for a scope-addressed forget. */
  findPendingByScope(scope: string): PendingAgentLaunchSnapshot | null {
    for (const entry of this.pendingByToken.values()) {
      if (entry.scope === scope) {
        return entry
      }
    }
    return null
  }

  /** Drop the in-flight snapshot once the operation settles (registered,
   *  failed, forgotten, or authoritatively reconciled). */
  clearPending(launchToken: string): boolean {
    this.inFlightSpawnTokens.delete(launchToken)
    const deleted = this.pendingByToken.delete(launchToken)
    if (deleted) {
      this.persistDurable()
    }
    return deleted
  }

  pendingSnapshots(): readonly PendingAgentLaunchSnapshot[] {
    return [...this.pendingByToken.values()]
  }

  /** Append a settled outcome, replacing any prior entry for the same operation
   *  and keeping only the newest MAX_SETTLED_OPERATIONS_PER_SCOPE per scope. */
  recordSettled(entry: SettledAgentLaunchOperation): void {
    this.appendSettled(entry)
    this.persistDurable()
  }

  /** Settle and drop the pending in ONE durable write. The single file image
   *  carries both effects, so a crash leaves either the old pending
   *  (reconcilable) or the settled entry (replayable) — never neither — while
   *  paying one fsync'd full-store rewrite instead of the two a
   *  recordSettled+clearPending pair costs on every launch settle. */
  settleAndClearPending(entry: SettledAgentLaunchOperation, launchToken: string): void {
    this.appendSettled(entry)
    this.inFlightSpawnTokens.delete(launchToken)
    this.pendingByToken.delete(launchToken)
    this.persistDurable()
  }

  private appendSettled(entry: SettledAgentLaunchOperation): void {
    const bucket = this.settledByScope.get(entry.scope) ?? []
    const next = bucket.filter((existing) => existing.operationId !== entry.operationId)
    next.push(entry)
    if (next.length > MAX_SETTLED_OPERATIONS_PER_SCOPE) {
      next.splice(0, next.length - MAX_SETTLED_OPERATIONS_PER_SCOPE)
    }
    // Re-insert so Map order is least-recently-settled first; the global bound
    // below evicts from that end.
    this.settledByScope.delete(entry.scope)
    this.settledByScope.set(entry.scope, next)
    this.evictOldestSettledScopes()
  }

  /** Drop whole scopes, least-recently-settled first, once the ledger exceeds the
   *  global bound. A scope with a live pending launch is skipped: its entries are
   *  the idempotency replay a retry of that in-flight launch still needs. */
  private evictOldestSettledScopes(): void {
    if (this.settledByScope.size <= MAX_SETTLED_OPERATION_SCOPES) {
      return
    }
    const pendingScopes = new Set([...this.pendingByToken.values()].map((pending) => pending.scope))
    for (const scope of Array.from(this.settledByScope.keys())) {
      if (this.settledByScope.size <= MAX_SETTLED_OPERATION_SCOPES) {
        return
      }
      if (!pendingScopes.has(scope)) {
        this.settledByScope.delete(scope)
      }
    }
  }

  /** Newest settled entry matching the idempotency key within the scope, or
   *  null. Newest-first so a replayed key returns its latest settled result. */
  findSettledByIdempotencyKey(
    scope: string,
    idempotencyKey: string
  ): SettledAgentLaunchOperation | null {
    const bucket = this.settledByScope.get(scope)
    if (!bucket) {
      return null
    }
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      if (bucket[index].idempotencyKey === idempotencyKey) {
        return bucket[index]
      }
    }
    return null
  }

  settledForScope(scope: string): readonly SettledAgentLaunchOperation[] {
    return this.settledByScope.get(scope) ?? []
  }

  /** Rehydrate durable in-flight snapshots at startup so reconciliation can
   *  attribute a terminal that outlived a main crash. */
  rebuildPendingFrom(entries: Iterable<PendingAgentLaunchSnapshot>): void {
    this.pendingByToken.clear()
    // inFlightSpawnTokens is intentionally untouched: it only ever holds tokens
    // this process is spawning right now (empty at boot rehydrate, and a
    // mid-process recovery merge must not drop a live spawn's guard).
    for (const entry of entries) {
      this.pendingByToken.set(entry.launchToken, entry)
    }
  }

  /** Rehydrate the settled ledger at startup. Applied in chronological order so
   *  the per-scope bound retains the genuinely newest entries. Never persists
   *  (like rebuildPendingFrom): the locked-keychain recovery sink rebuilds while
   *  installed as onDurableMutation, and persisting here would re-enter it. */
  rebuildSettledFrom(entries: Iterable<SettledAgentLaunchOperation>): void {
    this.settledByScope.clear()
    const ordered = [...entries].sort((a, b) => a.settledAt - b.settledAt)
    for (const entry of ordered) {
      this.appendSettled(entry)
    }
  }
}
