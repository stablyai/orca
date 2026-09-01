// Host-private launch-attribution + resume record store (U5). Holds the fields a
// client record must never carry (ruling D1): the immutable `launchSnapshot`, the
// opaque one-release `legacyLaunchConfig`, and the admission launch token. The
// runtime/mobile/paired session DTO exposes only requested/base identity, provider
// metadata, and notice/failure state; those live in the renderer store, not here.
//
// Two lifecycle stages, per plan §577/§579:
//   1. Registration at spawn time by stable pane + terminal id, BEFORE the PTY can
//      emit output/hooks. The provider session is not known yet, so the record is
//      staged and cannot be resumed. Rolled back on spawn failure.
//   2. Provider-session bind once a hook reports the session id: the staged record
//      is promoted to a durable record keyed by the {worktreeId, baseAgent,
//      providerSessionId} ownership key. A resume/fork request names that key and
//      the host loads the private record here. The record survives pane dispose so
//      a slept session still resumes; it is dropped only when explicitly forgotten.
//
// The store is a pure container: legacy-config validation and Agent Teams env
// stripping live in the ingestion/adapter layer, never here.

import type { TuiAgent, BuiltInTuiAgent } from '../../shared/types'
import type {
  AgentLaunchExecutionHostId,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import { PersistedSetCompleteness } from './persisted-set-completeness'
import { rehydrateSessionRecord } from './agent-session-record-rehydrate-validation'
import {
  getAgentSessionOwnershipKey,
  isResumableTuiAgent,
  providerSessionKeyForResumableBase,
  type AgentProviderSessionMetadata,
  type AgentSessionOwnershipKey,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import {
  AgentSessionVaultSnapshotIndex,
  type VaultSnapshotOwnerResolution
} from './agent-session-vault-snapshot-index'
import { recordsNotForgotten, sessionRecordKeysToEvict } from './agent-session-record-retention'
import { AgentSessionStagingRegistry } from './agent-session-staging-registry'

export type { VaultSnapshotOwnerResolution } from './agent-session-vault-snapshot-index'

/** A durable resume record, keyed by ownership key once a provider session binds.
 *  `launchSnapshot` (v1 replay authority) and `legacyLaunchConfig` (opaque
 *  one-release replay) are mutually exclusive in practice; a record with neither
 *  resolves current settings at resume (the snapshotless migration window). */
export type HostSessionLaunchRecord = {
  worktreeId: string
  requestedAgent: TuiAgent
  baseAgent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchSnapshot?: AgentLaunchSnapshot
  legacyLaunchConfig?: SleepingAgentLaunchConfig
  /** Recorded execution owner of a legacy record's sleeping pane. Opaque legacy
   *  replay re-checks it against the current spawn's owner on every resume (plan
   *  §573); v1-snapshot records carry provenance in the snapshot target instead. */
  legacyConnectionId?: string | null
  launchToken?: string
  registeredAt: number
  updatedAt: number
}

/** A spawn-time registration before any provider session is known. Keyed by
 *  launch token; rolled back on spawn failure and promoted to a durable record
 *  when the session binds. `baseAgent` may be non-resumable: such launches never
 *  bind a session. `paneKey`/`terminalId` are optional attribution metadata (the
 *  token drives bind/rollback); `paneKey` lets a pane teardown drop unbound
 *  staging, and surfaces without a stable pane key simply omit it. */
export type StagedLaunchRegistration = {
  paneKey?: string
  terminalId?: string
  worktreeId: string
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  launchSnapshot: AgentLaunchSnapshot
  launchToken: string
  registeredAt: number
}

/** The one-time legacy handoff: the renderer surrenders a pre-upgrade launch
 *  config on first resume over trusted desktop IPC. The host reconstructs the
 *  record from the ownership key it already holds and owns the config thereafter. */
export type LegacySessionRecordHandoff = {
  ownershipKey: AgentSessionOwnershipKey
  requestedAgent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  legacyLaunchConfig: SleepingAgentLaunchConfig
  /** Recorded execution owner of the sleeping pane, kept for later provenance
   *  re-checks once the host owns the config. */
  connectionId: string | null
}

/** The durable half snapshotted for the host-private sink: the ownership-keyed
 *  records only. Staging is in-flight and rebuilt from live terminals on restart
 *  via reconciliation, so it is never persisted. */
export type AgentSessionRecordStoreDurableState = {
  records: readonly HostSessionLaunchRecord[]
}

export class AgentSessionRecordStore {
  // Spawn-time registrations, keyed by launch token (the stable handle both the
  // spawn caller and the hook carry), before a session binds.
  private readonly staging = new AgentSessionStagingRegistry()
  // Durable resume records, keyed by ownership key.
  private readonly records = new Map<string, HostSessionLaunchRecord>()
  private readonly vaultIndex = new AgentSessionVaultSnapshotIndex()
  // launchToken -> ownership key of the record it bound to, so a spawn-failure
  // rollback of an already-bound launch removes its durable record too.
  private readonly ownershipByToken = new Map<string, string>()
  // Ownership keys explicitly forgotten since the last rebuild, so a deferred
  // locked-keychain recovery merge cannot resurrect a record the owner already
  // forgot in this process.
  private readonly forgottenSinceRebuild = new Set<string>()
  readonly recordCompleteness = new PersistedSetCompleteness()
  private readonly now: () => number
  private onDurableMutation: ((state: AgentSessionRecordStoreDurableState) => void) | null = null

  constructor(deps?: { now?: () => number }) {
    this.now = deps?.now ?? (() => Date.now())
  }

  /** Attach (or replace) the durable sink. Not called during rehydrate, so the
   *  load path never writes back the state it just read. */
  setDurablePersistence(sink: (state: AgentSessionRecordStoreDurableState) => void): void {
    this.onDurableMutation = sink
  }

  durableState(): AgentSessionRecordStoreDurableState {
    return { records: [...this.records.values()] }
  }

  private persistDurable(): void {
    this.onDurableMutation?.(this.durableState())
  }

  private deleteDurableRecord(ownershipKey: string): boolean {
    const record = this.records.get(ownershipKey)
    if (!record) {
      return false
    }
    this.vaultIndex.remove(ownershipKey, record)
    this.records.delete(ownershipKey)
    if (record.launchToken && this.ownershipByToken.get(record.launchToken) === ownershipKey) {
      this.ownershipByToken.delete(record.launchToken)
    }
    return true
  }

  /** §577 spawn-time registration, keyed by launch token. Held in staging; not
   *  resumable until a hook binds its provider session. */
  register(registration: Omit<StagedLaunchRegistration, 'registeredAt'>): void {
    this.staging.add({ ...registration, registeredAt: this.now() })
  }

  /** Drop a staged registration on spawn failure. If it was already promoted, the
   *  bound durable record is removed too so a failed spawn strands nothing. */
  rollbackByToken(launchToken: string): void {
    this.staging.delete(launchToken)
    const ownershipKey = this.ownershipByToken.get(launchToken)
    if (ownershipKey) {
      this.ownershipByToken.delete(launchToken)
      const record = this.records.get(ownershipKey)
      if (record?.launchToken === launchToken && this.deleteDurableRecord(ownershipKey)) {
        this.persistDurable()
      }
    }
  }

  /** Drop the in-flight staging for a pane when its PTY ends. The durable record
   *  (if the session bound) is intentionally KEPT so a slept session resumes; only
   *  the unbound staging handle is cleared. */
  disposeStagingForPane(paneKey: string): void {
    this.staging.disposeForPane(paneKey)
  }

  /** The same teardown by terminal id, for the runtime/mobile surfaces that
   *  register a terminal but never a pane key — without it their staging is
   *  unreachable by any cleanup and leaks a launch snapshot per launch. */
  disposeStagingForTerminal(terminalId: string): void {
    this.staging.disposeForTerminal(terminalId)
  }

  /** Promote a staged registration to a durable resume record once a hook reports
   *  the provider session for its launch token. The record's OWN base agent (host
   *  attribution) — never the hook's provider evidence — drives the ownership key,
   *  and the hook's session is accepted only when its key type matches that base.
   *  An incompatible provider type is rejected (returns null) without rewriting the
   *  staged identity; a non-resumable base can never bind. A successful bind
   *  consumes its staging entry, so a repeated hook for the same launch is a null
   *  no-op (an incompatible attempt keeps staging so a later compatible hook wins). */
  bindProviderSessionByToken(
    launchToken: string,
    providerSession: AgentProviderSessionMetadata
  ): HostSessionLaunchRecord | null {
    const staged = this.staging.get(launchToken)
    if (!staged) {
      // Session ROTATION: the token already bound, then the provider minted a
      // new session id in the same pane (e.g. Claude /clear). Re-bind the same
      // launch under the new ownership key, keeping the snapshot; the prior
      // record stays — its transcript is still an independently valid resume
      // target. A repeat hook for the already-bound id stays a null no-op.
      return this.rebindRotatedProviderSession(launchToken, providerSession)
    }
    if (
      !isResumableTuiAgent(staged.baseAgent) ||
      providerSession.key !== providerSessionKeyForResumableBase(staged.baseAgent)
    ) {
      return null
    }
    const ownershipKey = getAgentSessionOwnershipKey({
      worktreeId: staged.worktreeId,
      baseAgent: staged.baseAgent,
      providerSessionId: providerSession.id
    })
    const record: HostSessionLaunchRecord = {
      worktreeId: staged.worktreeId,
      requestedAgent: staged.requestedAgent,
      baseAgent: staged.baseAgent,
      providerSession,
      launchSnapshot: staged.launchSnapshot,
      launchToken: staged.launchToken,
      registeredAt: staged.registeredAt,
      updatedAt: this.now()
    }
    const replaced = this.records.get(ownershipKey)
    if (replaced) {
      this.vaultIndex.remove(ownershipKey, replaced)
      if (replaced.launchToken && replaced.launchToken !== launchToken) {
        this.ownershipByToken.delete(replaced.launchToken)
      }
    }
    this.records.set(ownershipKey, record)
    this.vaultIndex.add(ownershipKey, record)
    this.ownershipByToken.set(launchToken, ownershipKey)
    // Consume the staging entry so repeated hook events for the same launch are a
    // cheap no-op (no duplicate durable write); rollback still finds the bound
    // record via the ownership index.
    this.staging.delete(launchToken)
    this.evictOverflowRecords()
    this.persistDurable()
    return record
  }

  /** Enforce the global retention bound after an insert. */
  private evictOverflowRecords(): void {
    for (const ownershipKey of sessionRecordKeysToEvict(this.records)) {
      this.deleteDurableRecord(ownershipKey)
    }
  }

  /** Re-key an already-bound launch to a ROTATED provider session id. The
   *  bound record's own base drives the key exactly like the first bind; an
   *  incompatible provider key or an unchanged session id is a null no-op. */
  private rebindRotatedProviderSession(
    launchToken: string,
    providerSession: AgentProviderSessionMetadata
  ): HostSessionLaunchRecord | null {
    const boundKey = this.ownershipByToken.get(launchToken)
    const bound = boundKey ? this.records.get(boundKey) : undefined
    if (
      !boundKey ||
      !bound ||
      bound.launchToken !== launchToken ||
      bound.providerSession.id === providerSession.id ||
      providerSession.key !== providerSessionKeyForResumableBase(bound.baseAgent)
    ) {
      return null
    }
    const ownershipKey = getAgentSessionOwnershipKey({
      worktreeId: bound.worktreeId,
      baseAgent: bound.baseAgent,
      providerSessionId: providerSession.id
    })
    const record: HostSessionLaunchRecord = {
      ...bound,
      providerSession,
      updatedAt: this.now()
    }
    const replaced = this.records.get(ownershipKey)
    if (replaced) {
      this.vaultIndex.remove(ownershipKey, replaced)
      if (replaced.launchToken && replaced.launchToken !== launchToken) {
        this.ownershipByToken.delete(replaced.launchToken)
      }
    }
    // The token now attributes the NEWEST session; the prior record keeps its
    // key but drops the token claim so a rollback cannot delete the wrong one.
    const { launchToken: _dropped, ...priorWithoutToken } = bound
    this.vaultIndex.remove(boundKey, bound)
    this.records.set(boundKey, priorWithoutToken)
    this.vaultIndex.add(boundKey, priorWithoutToken)
    this.records.set(ownershipKey, record)
    this.vaultIndex.add(ownershipKey, record)
    this.ownershipByToken.set(launchToken, ownershipKey)
    this.evictOverflowRecords()
    this.persistDurable()
    return record
  }

  /** Resolve the private record a resume/fork request names. */
  resolveByOwnershipKey(key: AgentSessionOwnershipKey): HostSessionLaunchRecord | null {
    return this.records.get(getAgentSessionOwnershipKey(key)) ?? null
  }

  /** Correlate a freshly scanned Vault row to one eligible v1 snapshot owner. */
  resolveVaultSnapshotOwner(args: {
    baseAgent: ResumableTuiAgent
    scannedProviderSessionId: string
    scannedTranscriptPath?: string | null
    targetExecutionHostId: AgentLaunchExecutionHostId
    targetPlatform: NodeJS.Platform
    preferredWorktreeId?: string | null
  }): VaultSnapshotOwnerResolution {
    return this.vaultIndex.resolve(args, this.records)
  }

  /** Return only the captured non-executable argv after conservative Vault
   * correlation. This is the narrow disclosure used by expanded details. */
  resolveVaultSnapshotArguments(args: {
    baseAgent: ResumableTuiAgent
    scannedProviderSessionId: string
    scannedTranscriptPath?: string | null
    scannedExecutionHostId: string
  }): readonly string[] | null {
    const owner = this.vaultIndex.resolveForDiscoveredHost(args, this.records)
    if (owner.kind !== 'found') {
      return null
    }
    const record = this.resolveByOwnershipKey(owner.sessionKey)
    return record?.launchSnapshot ? record.launchSnapshot.argv.slice(1) : null
  }

  /** Requested identities of every durable resume record, for the tombstone
   *  reference index's `session` owner (plan §266). Each bound resumable session
   *  registers here, so a custom id still named here keeps its tombstone retained
   *  until the session is forgotten. */
  referencedRequestedAgents(): TuiAgent[] {
    return [...this.records.values()].map((record) => record.requestedAgent)
  }

  /** Count durable resume records whose base harness is `base`, for §973
   *  base-disable impact. Records are keyed by their host-attributed base, so a
   *  derivative launch (baseAgent === base) is counted alongside a direct base
   *  launch — every session that will block when the harness is disabled. */
  countRecordsByBase(base: BuiltInTuiAgent): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.baseAgent === base) {
        count += 1
      }
    }
    return count
  }

  /** Accept the one-time legacy launch config the renderer surrenders on first
   *  resume. Ignored when the host already owns a record for the key (already
   *  handed over): "renderer hands it over once; host owns it thereafter". */
  ingestLegacyRecord(handoff: LegacySessionRecordHandoff): HostSessionLaunchRecord {
    const ownershipKey = getAgentSessionOwnershipKey(handoff.ownershipKey)
    const existing = this.records.get(ownershipKey)
    if (existing) {
      return existing
    }
    const now = this.now()
    const record: HostSessionLaunchRecord = {
      worktreeId: handoff.ownershipKey.worktreeId,
      requestedAgent: handoff.requestedAgent,
      baseAgent: handoff.ownershipKey.baseAgent,
      providerSession: handoff.providerSession,
      legacyLaunchConfig: handoff.legacyLaunchConfig,
      legacyConnectionId: handoff.connectionId,
      registeredAt: now,
      updatedAt: now
    }
    this.records.set(ownershipKey, record)
    this.vaultIndex.add(ownershipKey, record)
    this.evictOverflowRecords()
    this.persistDurable()
    return record
  }

  /** Owner-authorized forget: drop the durable record entirely. */
  forget(key: AgentSessionOwnershipKey): boolean {
    const ownershipKey = getAgentSessionOwnershipKey(key)
    const deleted = this.deleteDurableRecord(ownershipKey)
    if (deleted) {
      this.forgottenSinceRebuild.add(ownershipKey)
      this.persistDurable()
    }
    return deleted
  }

  /** Merge late-decrypted on-disk records UNDER the live in-memory ones (a
   *  fresh bind wins its ownership key), excluding keys forgotten since boot so
   *  a locked-keychain recovery merge cannot resurrect a forgotten session. */
  mergeRehydratedRecords(records: Iterable<HostSessionLaunchRecord>): void {
    this.rebuildRecordsFrom([
      ...recordsNotForgotten(records, this.forgottenSinceRebuild),
      ...this.records.values()
    ])
  }

  /** Rehydrate durable records at startup. Not routed through the sink. */
  rebuildRecordsFrom(records: Iterable<HostSessionLaunchRecord>): void {
    this.records.clear()
    this.vaultIndex.clear()
    this.ownershipByToken.clear()
    this.forgottenSinceRebuild.clear()
    for (const record of records) {
      const rehydrated = rehydrateSessionRecord(record)
      if (!rehydrated) {
        continue
      }
      this.records.set(rehydrated.ownershipKey, rehydrated.record)
      this.vaultIndex.add(rehydrated.ownershipKey, rehydrated.record)
      if (rehydrated.record.launchToken) {
        this.ownershipByToken.set(rehydrated.record.launchToken, rehydrated.ownershipKey)
      }
    }
    // A file written before the bound existed can exceed it; trim at rehydrate so
    // the first mutation does not re-serialize an unbounded history.
    this.evictOverflowRecords()
  }
}
