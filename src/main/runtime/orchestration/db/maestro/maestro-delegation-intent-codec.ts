import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import {
  buildMaestroDelegationIntent,
  type MaestroDelegationIntent,
  type MaestroDelegationRequest,
  type MaestroDelegationResolvedProfile,
  type MaestroDelegationState
} from '../../../../../shared/maestro-delegation'
import type { MaestroActor } from '../../../../../shared/maestro-contract'
import type { OrchestrationDb } from '../orchestration-db'

export type StoredIntentEnvelope = {
  request: MaestroDelegationRequest
  actor: MaestroActor
  coordinator_generation: number
  resolved: MaestroDelegationResolvedProfile
  state: MaestroDelegationState
  spawned_by: string | null
}

export type StoredIntentRow = {
  intent_id: string
  execution_host_id: string
  workspace_key: string
  run_id: string
  requester_principal: string
  requester_kind: MaestroActor['kind']
  coordinator_generation: number
  state: 'pending' | 'claimed' | 'settled' | 'rejected'
  consumer_principal: string | null
  payload_json: string
  receipt_json: string | null
  current_generation: number | null
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      return nested
    }
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => left.localeCompare(right))
    )
  })
}

export function sameCanonicalJson(stored: string | null, candidate: unknown): boolean {
  if (stored === null) {
    return candidate === null
  }
  try {
    return canonicalJson(JSON.parse(stored)) === canonicalJson(candidate)
  } catch {
    return false
  }
}

export function readEnvelope(row: StoredIntentRow): StoredIntentEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(row.payload_json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const envelope = parsed as Partial<StoredIntentEnvelope>
    return envelope.request && envelope.actor && envelope.resolved && envelope.state
      ? (envelope as StoredIntentEnvelope)
      : null
  } catch {
    return null
  }
}

export function getStoredIntent(
  this: OrchestrationDb,
  intentId: string
): StoredIntentRow | undefined {
  return this.db
    .prepare(`SELECT intent.*, run.consumer_generation AS current_generation
    FROM maestro_delegation_intents AS intent LEFT JOIN runs AS run ON run.id = intent.run_id
    WHERE intent.intent_id = ?`)
    .get(intentId) as StoredIntentRow | undefined
}

export function rowMatchesPrincipal(principal: MaestroPrincipal, row: StoredIntentRow): boolean {
  return (
    principal.kind === 'coordinator' &&
    principal.generation === row.current_generation &&
    principal.generation === row.coordinator_generation &&
    principal.workspace.execution_host_id === row.execution_host_id &&
    principal.workspace.workspace_key === row.workspace_key &&
    principal.workspace.run_id === row.run_id
  )
}

export function requesterMatchesPrincipal(
  principal: MaestroPrincipal,
  actor: MaestroActor
): boolean {
  return (
    actor.actor_id === principal.actor_id &&
    actor.kind === principal.kind &&
    actor.session_id === principal.session_id
  )
}

export function envelopeToIntent(
  envelope: StoredIntentEnvelope,
  state: MaestroDelegationState
): MaestroDelegationIntent {
  return buildMaestroDelegationIntent(envelope.request, {
    actor: envelope.actor,
    coordinatorGeneration: envelope.coordinator_generation,
    resolved: envelope.resolved,
    state,
    spawnedBy: envelope.spawned_by
  })
}

export function mapStoredState(
  rowState: StoredIntentRow['state'],
  envelopeState: MaestroDelegationState
): MaestroDelegationState {
  return rowState === 'pending' || rowState === 'claimed' ? rowState : envelopeState
}
