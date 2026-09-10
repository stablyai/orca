import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import {
  parseMaestroDelegationSettlement,
  type MaestroDelegationIntent,
  type MaestroDelegationRequest,
  type MaestroDelegationResolvedProfile,
  type MaestroDelegationState
} from '../../../../../shared/maestro-delegation'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  canonicalJson,
  envelopeToIntent,
  getStoredIntent,
  mapStoredState,
  readEnvelope,
  requesterMatchesPrincipal,
  rowMatchesPrincipal,
  sameCanonicalJson,
  type StoredIntentEnvelope
} from './maestro-delegation-intent-codec'

function coordinatorSessionIdentity(principal: MaestroPrincipal): string {
  return `${principal.actor_id}:${principal.session_id}`
}

export function getMaestroDelegation(
  this: OrchestrationDb,
  intentId: string,
  principal: MaestroPrincipal
): MaestroDelegationIntent | undefined {
  const row = getStoredIntent.call(this, intentId)
  const envelope = row ? readEnvelope(row) : null
  if (!row || !envelope) {
    return undefined
  }
  const sameWorkspace =
    principal.workspace.execution_host_id === row.execution_host_id &&
    principal.workspace.workspace_key === row.workspace_key &&
    principal.workspace.run_id === row.run_id
  if (
    !sameWorkspace ||
    (!requesterMatchesPrincipal(principal, envelope.actor) && !rowMatchesPrincipal(principal, row))
  ) {
    return undefined
  }
  return envelopeToIntent(envelope, mapStoredState(row.state, envelope.state))
}

export function requestMaestroDelegation(
  this: OrchestrationDb,
  request: MaestroDelegationRequest,
  principal: MaestroPrincipal,
  resolved: MaestroDelegationResolvedProfile
): MaestroDelegationIntent {
  const envelope: StoredIntentEnvelope = {
    request,
    actor: {
      actor_id: principal.actor_id,
      kind: principal.kind,
      authenticated: true,
      session_id: principal.session_id
    },
    coordinator_generation: principal.generation ?? 1,
    resolved,
    state: 'pending',
    spawned_by: null
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getStoredIntent.call(this, request.intent_id)
    if (existing) {
      const stored = readEnvelope(existing)
      if (
        !stored ||
        !requesterMatchesPrincipal(principal, stored.actor) ||
        !sameCanonicalJson(JSON.stringify(stored.request), request)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'Delegation intent ID was reused with different input.'
        )
      }
      this.db.exec('COMMIT')
      return envelopeToIntent(stored, mapStoredState(existing.state, stored.state))
    }
    this.db
      .prepare(`INSERT INTO maestro_delegation_intents (
      intent_id, execution_host_id, workspace_key, run_id, requester_principal,
      requester_kind, coordinator_generation, state, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(
        request.intent_id,
        request.workspace.execution_host_id,
        request.workspace.workspace_key,
        request.workspace.run_id,
        principal.actor_id,
        principal.kind,
        envelope.coordinator_generation,
        canonicalJson(envelope)
      )
    this.db.exec('COMMIT')
    return envelopeToIntent(envelope, 'pending')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function takeMaestroDelegation(
  this: OrchestrationDb,
  intentId: string,
  principal: MaestroPrincipal
): MaestroDelegationIntent | undefined {
  if (principal.generation === undefined) {
    return undefined
  }
  const row = getStoredIntent.call(this, intentId)
  const envelope = row ? readEnvelope(row) : null
  if (!row || !envelope || !rowMatchesPrincipal(principal, row)) {
    return undefined
  }
  const consumerIdentity = coordinatorSessionIdentity(principal)
  if (row.state === 'claimed' && row.consumer_principal === consumerIdentity) {
    return envelopeToIntent(envelope, 'claimed')
  }
  if (row.state !== 'pending') {
    return undefined
  }
  const updated = this.db
    .prepare(`UPDATE maestro_delegation_intents SET state = 'claimed', consumer_principal = ?, updated_at = datetime('now')
    WHERE intent_id = ? AND state = 'pending' AND coordinator_generation = ?
      AND execution_host_id = ? AND workspace_key = ? AND run_id = ?
      AND EXISTS (SELECT 1 FROM runs WHERE id = maestro_delegation_intents.run_id AND consumer_generation = ?)`)
    .run(
      consumerIdentity,
      intentId,
      principal.generation,
      principal.workspace.execution_host_id,
      principal.workspace.workspace_key,
      principal.workspace.run_id,
      principal.generation
    )
  return updated.changes === 1 ? envelopeToIntent(envelope, 'claimed') : undefined
}

export function settleMaestroDelegation(
  this: OrchestrationDb,
  intentId: string,
  principal: MaestroPrincipal,
  receiptValue: unknown
): MaestroDelegationIntent | undefined {
  if (principal.generation === undefined) {
    return undefined
  }
  const receipt = parseMaestroDelegationSettlement(receiptValue)
  const row = getStoredIntent.call(this, intentId)
  const envelope = row ? readEnvelope(row) : null
  const consumerIdentity = coordinatorSessionIdentity(principal)
  if (
    !row ||
    !envelope ||
    !rowMatchesPrincipal(principal, row) ||
    row.consumer_principal !== consumerIdentity
  ) {
    return undefined
  }
  if (row.state === 'settled') {
    if (!sameCanonicalJson(row.receipt_json, receipt)) {
      throw new OrchestrationError(
        'request_mismatch',
        'Delegation settlement was replayed with a different receipt.'
      )
    }
    return envelopeToIntent(envelope, envelope.state)
  }
  if (row.state !== 'claimed') {
    return undefined
  }
  if (receipt.outcome === 'succeeded' && !receipt.worker.tracked) {
    throw new OrchestrationError(
      'invalid_argument',
      'A successful delegation must reference a tracked worker; loose terminals are not workers.'
    )
  }
  const state = receipt.outcome as Exclude<MaestroDelegationState, 'claimed' | 'pending'>
  const nextEnvelope: StoredIntentEnvelope = {
    ...envelope,
    state,
    spawned_by:
      receipt.outcome === 'succeeded' && envelope.actor.kind === 'worker'
        ? envelope.actor.actor_id
        : envelope.spawned_by
  }
  const updated = this.db
    .prepare(`UPDATE maestro_delegation_intents SET state = 'settled', receipt_json = ?, payload_json = ?, updated_at = datetime('now')
    WHERE intent_id = ? AND state = 'claimed' AND consumer_principal = ? AND coordinator_generation = ?
      AND execution_host_id = ? AND workspace_key = ? AND run_id = ?
      AND EXISTS (SELECT 1 FROM runs WHERE id = maestro_delegation_intents.run_id AND consumer_generation = ?)`)
    .run(
      canonicalJson(receipt),
      canonicalJson(nextEnvelope),
      intentId,
      consumerIdentity,
      principal.generation,
      principal.workspace.execution_host_id,
      principal.workspace.workspace_key,
      principal.workspace.run_id,
      principal.generation
    )
  return updated.changes === 1 ? envelopeToIntent(nextEnvelope, state) : undefined
}

export type MaestroDelegationIntentStoreMethods = {
  getMaestroDelegation: typeof getMaestroDelegation
  requestMaestroDelegation: typeof requestMaestroDelegation
  takeMaestroDelegation: typeof takeMaestroDelegation
  settleMaestroDelegation: typeof settleMaestroDelegation
}

export function attachMaestroDelegationIntentStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getMaestroDelegation,
    requestMaestroDelegation,
    takeMaestroDelegation,
    settleMaestroDelegation
  })
}
