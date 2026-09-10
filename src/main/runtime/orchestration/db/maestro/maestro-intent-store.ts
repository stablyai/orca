import type { DelegationIntent } from '../../../../../shared/maestro-contract'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

type StoredIntentRow = {
  state: 'pending' | 'claimed' | 'settled' | 'rejected'
  coordinator_generation: number
  execution_host_id: string
  workspace_key: string
  run_id: string
  consumer_principal: string | null
  payload_json: string
  receipt_json: string | null
  current_generation: number | null
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      return nested
    }
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => left.localeCompare(right))
    )
  })
}

function sameCanonicalJson(stored: string | null, candidate: unknown): boolean {
  if (stored === null) {
    return candidate === null
  }
  try {
    return canonicalJson(JSON.parse(stored)) === canonicalJson(candidate)
  } catch {
    return false
  }
}

function principalMatchesIntent(principal: MaestroPrincipal, row: StoredIntentRow): boolean {
  return (
    principal.kind === 'coordinator' &&
    row.current_generation === principal.generation &&
    principal.generation === row.coordinator_generation &&
    principal.workspace.execution_host_id === row.execution_host_id &&
    principal.workspace.workspace_key === row.workspace_key &&
    principal.workspace.run_id === row.run_id
  )
}

export function requestMaestroDelegationIntent(
  this: OrchestrationDb,
  intent: DelegationIntent,
  principal: MaestroPrincipal
): { intentId: string; state: StoredIntentRow['state'] } {
  const payloadJson = canonicalJson(intent)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = this.db
      .prepare('SELECT * FROM maestro_delegation_intents WHERE intent_id = ?')
      .get(intent.intent_id) as StoredIntentRow | undefined
    if (existing) {
      if (!sameCanonicalJson(existing.payload_json, intent)) {
        throw new OrchestrationError(
          'request_mismatch',
          'Delegation intent ID was reused with different input.'
        )
      }
      this.db.exec('COMMIT')
      return { intentId: intent.intent_id, state: existing.state }
    }
    this.db
      .prepare(
        `INSERT INTO maestro_delegation_intents (intent_id, execution_host_id, workspace_key, run_id, requester_principal, requester_kind, coordinator_generation, state, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        intent.intent_id,
        intent.workspace.execution_host_id,
        intent.workspace.workspace_key,
        intent.workspace.run_id,
        principal.actor_id,
        principal.kind,
        intent.coordinator_generation,
        payloadJson
      )
    this.db.exec('COMMIT')
    return { intentId: intent.intent_id, state: 'pending' }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function takeMaestroDelegationIntent(
  this: OrchestrationDb,
  intentId: string,
  principal: MaestroPrincipal
): DelegationIntent | undefined {
  if (principal.generation === undefined) {
    return undefined
  }
  const row = this.db
    .prepare(
      `SELECT intent.*, run.consumer_generation AS current_generation
       FROM maestro_delegation_intents AS intent
       LEFT JOIN runs AS run ON run.id = intent.run_id
       WHERE intent.intent_id = ?`
    )
    .get(intentId) as StoredIntentRow | undefined
  if (!row || !principalMatchesIntent(principal, row)) {
    return undefined
  }
  if (row.state === 'claimed' && row.consumer_principal === principal.actor_id) {
    return JSON.parse(row.payload_json) as DelegationIntent
  }
  if (row.state !== 'pending') {
    return undefined
  }
  const updated = this.db
    .prepare(
      `UPDATE maestro_delegation_intents
       SET state = 'claimed', consumer_principal = ?, updated_at = datetime('now')
       WHERE intent_id = ? AND state = 'pending' AND coordinator_generation = ?
         AND execution_host_id = ? AND workspace_key = ? AND run_id = ?
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = maestro_delegation_intents.run_id AND consumer_generation = ?
         )`
    )
    .run(
      principal.actor_id,
      intentId,
      principal.generation,
      principal.workspace.execution_host_id,
      principal.workspace.workspace_key,
      principal.workspace.run_id,
      principal.generation
    )
  return updated.changes === 1 ? (JSON.parse(row.payload_json) as DelegationIntent) : undefined
}

export function settleMaestroDelegationIntent(
  this: OrchestrationDb,
  intentId: string,
  principal: MaestroPrincipal,
  receipt: unknown
): boolean {
  if (principal.generation === undefined) {
    return false
  }
  const row = this.db
    .prepare(
      `SELECT intent.*, run.consumer_generation AS current_generation
       FROM maestro_delegation_intents AS intent
       LEFT JOIN runs AS run ON run.id = intent.run_id
       WHERE intent.intent_id = ?`
    )
    .get(intentId) as StoredIntentRow | undefined
  if (
    !row ||
    !principalMatchesIntent(principal, row) ||
    row.consumer_principal !== principal.actor_id
  ) {
    return false
  }
  if (row.state === 'settled') {
    if (!sameCanonicalJson(row.receipt_json, receipt)) {
      throw new OrchestrationError(
        'request_mismatch',
        'Delegation settlement was replayed with a different receipt.'
      )
    }
    return true
  }
  if (row.state !== 'claimed') {
    return false
  }
  return (
    this.db
      .prepare(
        `UPDATE maestro_delegation_intents
         SET state = 'settled', receipt_json = ?, updated_at = datetime('now')
         WHERE intent_id = ? AND state = 'claimed' AND consumer_principal = ?
           AND coordinator_generation = ? AND execution_host_id = ? AND workspace_key = ?
           AND run_id = ?
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE id = maestro_delegation_intents.run_id AND consumer_generation = ?
           )`
      )
      .run(
        canonicalJson(receipt),
        intentId,
        principal.actor_id,
        principal.generation,
        principal.workspace.execution_host_id,
        principal.workspace.workspace_key,
        principal.workspace.run_id,
        principal.generation
      ).changes === 1
  )
}

export function listMaestroCanvasIndex(this: OrchestrationDb): {
  executionHostId: string
  workspaceKey: string
  revision: number
  updatedAt: string
  intentCounts: { pending: number; claimed: number; settled: number }
}[] {
  return this.db
    .prepare(
      `SELECT d.execution_host_id, d.workspace_key, d.revision, d.updated_at, SUM(CASE WHEN i.state = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN i.state = 'claimed' THEN 1 ELSE 0 END) AS claimed, SUM(CASE WHEN i.state = 'settled' THEN 1 ELSE 0 END) AS settled FROM maestro_documents d LEFT JOIN maestro_delegation_intents i ON i.execution_host_id = d.execution_host_id AND i.workspace_key = d.workspace_key GROUP BY d.execution_host_id, d.workspace_key ORDER BY d.updated_at DESC`
    )
    .all()
    .map((row) => {
      const value = row as {
        execution_host_id: string
        workspace_key: string
        revision: number
        updated_at: string
        pending: number
        claimed: number
        settled: number
      }
      return {
        executionHostId: value.execution_host_id,
        workspaceKey: value.workspace_key,
        revision: value.revision,
        updatedAt: value.updated_at,
        intentCounts: { pending: value.pending, claimed: value.claimed, settled: value.settled }
      }
    })
}

export type MaestroIntentStoreMethods = {
  requestMaestroDelegationIntent: typeof requestMaestroDelegationIntent
  takeMaestroDelegationIntent: typeof takeMaestroDelegationIntent
  settleMaestroDelegationIntent: typeof settleMaestroDelegationIntent
  listMaestroCanvasIndex: typeof listMaestroCanvasIndex
}

export function attachMaestroIntentStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requestMaestroDelegationIntent,
    takeMaestroDelegationIntent,
    settleMaestroDelegationIntent,
    listMaestroCanvasIndex
  })
}
