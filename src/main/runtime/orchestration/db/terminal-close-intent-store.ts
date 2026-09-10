import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from './orchestration-db'

export type TerminalCloseIntentState =
  | 'reserved'
  | 'closing'
  | 'released'
  | 'outcome_unknown'
  | 'capability_limited'

export type TerminalCloseIntent = {
  mutationId: string
  executionHostId: string
  workspaceKey: string
  terminalHandle: string
  targetKind: 'terminal' | 'terminal-tab'
  ptyIncarnation: string
  processRootId: string
  ownerPrincipal: string
  reason: string
  state: TerminalCloseIntentState
  autoRelease: boolean
  result: unknown
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type ReserveTerminalCloseIntentParams = Omit<
  TerminalCloseIntent,
  'state' | 'autoRelease' | 'result' | 'lastError' | 'createdAt' | 'updatedAt'
>

type TerminalCloseIntentRow = {
  mutation_id: string
  execution_host_id: string
  workspace_key: string
  terminal_handle: string
  target_kind: TerminalCloseIntent['targetKind']
  pty_incarnation: string
  process_root_id: string
  owner_principal: string
  reason: string
  state: TerminalCloseIntentState
  auto_release: number
  result_json: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export function getTerminalCloseIntent(
  this: OrchestrationDb,
  mutationId: string
): TerminalCloseIntent | undefined {
  const row = this.db
    .prepare('SELECT * FROM terminal_close_intents WHERE mutation_id = ?')
    .get(mutationId) as TerminalCloseIntentRow | undefined
  return row ? deserializeIntent(row) : undefined
}

export function assertTerminalCloseIntentAuthority(
  this: OrchestrationDb,
  params: Pick<ReserveTerminalCloseIntentParams, 'terminalHandle' | 'ptyIncarnation'>
): void {
  const worker = this.db
    .prepare(
      `SELECT owner_dispatch_id FROM worker_terminal_resources
       WHERE terminal_handle = ? AND process_incarnation = ? AND ownership_state = 'owned'
         AND release_state != 'released' ORDER BY updated_at DESC LIMIT 1`
    )
    .get(params.terminalHandle, params.ptyIncarnation) as { owner_dispatch_id: string } | undefined
  if (worker) {
    throw new OrchestrationError(
      'worker_release_required',
      `Terminal ${params.terminalHandle} is owned by a worker release authority.`,
      { authority: 'worker-release', dispatchId: worker.owner_dispatch_id }
    )
  }
  const lease = this.getMaestroTerminalLeaseByHandle(params.terminalHandle)
  if (lease) {
    const resource = lease.workerTerminalResourceId
      ? this.getWorkerTerminalResource(lease.workerTerminalResourceId)
      : undefined
    const releasedToOwner =
      lease.role === 'worker' &&
      lease.ptyIncarnation === params.ptyIncarnation &&
      resource?.terminal_handle === params.terminalHandle &&
      resource.process_incarnation === params.ptyIncarnation &&
      resource.ownership_state === 'external' &&
      resource.release_state === 'retained' &&
      resource.retained_reason === 'external_terminal' &&
      ['succeeded', 'failed'].includes(
        this.getWorkerDispatch(resource.owner_dispatch_id)?.state ?? ''
      )
    if (releasedToOwner) {
      return
    }
    const authority = lease.role === 'worker' ? 'worker-release' : 'coordinator-lease'
    throw new OrchestrationError(
      lease.role === 'worker' ? 'worker_release_required' : 'coordinator_lease_required',
      `Terminal ${params.terminalHandle} is owned by ${authority}.`,
      { authority, leaseId: lease.id }
    )
  }
}

export function reserveTerminalCloseIntent(
  this: OrchestrationDb,
  params: ReserveTerminalCloseIntentParams
): TerminalCloseIntent {
  this.db.exec('SAVEPOINT terminal_close_intent_reserve')
  try {
    const byMutation = this.getTerminalCloseIntent(params.mutationId)
    if (byMutation) {
      assertSameIdentity(byMutation, params)
      this.db.exec('RELEASE terminal_close_intent_reserve')
      return byMutation
    }
    this.assertTerminalCloseIntentAuthority(params)
    const byIdentity = getIntentByIdentity.call(this, params)
    if (byIdentity) {
      this.db.exec('RELEASE terminal_close_intent_reserve')
      return byIdentity
    }
    this.db
      .prepare(
        `INSERT INTO terminal_close_intents (
          mutation_id, execution_host_id, workspace_key, terminal_handle, target_kind,
          pty_incarnation, process_root_id, owner_principal, reason, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`
      )
      .run(
        params.mutationId,
        params.executionHostId,
        params.workspaceKey,
        params.terminalHandle,
        params.targetKind,
        params.ptyIncarnation,
        params.processRootId,
        params.ownerPrincipal,
        params.reason
      )
    const created = this.getTerminalCloseIntent(params.mutationId)
    this.db.exec('RELEASE terminal_close_intent_reserve')
    return created as TerminalCloseIntent
  } catch (error) {
    this.db.exec('ROLLBACK TO terminal_close_intent_reserve')
    this.db.exec('RELEASE terminal_close_intent_reserve')
    throw error
  }
}

export function updateTerminalCloseIntent(
  this: OrchestrationDb,
  mutationId: string,
  update: {
    state: TerminalCloseIntentState
    result?: unknown
    lastError?: string | null
    autoRelease?: boolean
  }
): TerminalCloseIntent {
  const changed = this.db
    .prepare(
      `UPDATE terminal_close_intents SET state = ?, result_json = ?, last_error = ?,
         auto_release = ?, updated_at = datetime('now') WHERE mutation_id = ?`
    )
    .run(
      update.state,
      update.result === undefined ? null : JSON.stringify(update.result),
      update.lastError ?? null,
      update.autoRelease === true ? 1 : 0,
      mutationId
    )
  if (changed.changes !== 1) {
    throw new OrchestrationError(
      'close_intent_not_found',
      `Close intent ${mutationId} was not found.`
    )
  }
  return this.getTerminalCloseIntent(mutationId) as TerminalCloseIntent
}

function getIntentByIdentity(
  this: OrchestrationDb,
  params: ReserveTerminalCloseIntentParams
): TerminalCloseIntent | undefined {
  const row = this.db
    .prepare(
      `SELECT * FROM terminal_close_intents WHERE execution_host_id = ? AND workspace_key = ?
       AND terminal_handle = ? AND pty_incarnation = ? AND process_root_id = ?`
    )
    .get(
      params.executionHostId,
      params.workspaceKey,
      params.terminalHandle,
      params.ptyIncarnation,
      params.processRootId
    ) as TerminalCloseIntentRow | undefined
  return row ? deserializeIntent(row) : undefined
}

function assertSameIdentity(
  existing: TerminalCloseIntent,
  params: ReserveTerminalCloseIntentParams
): void {
  if (
    existing.executionHostId !== params.executionHostId ||
    existing.workspaceKey !== params.workspaceKey ||
    existing.terminalHandle !== params.terminalHandle ||
    existing.targetKind !== params.targetKind ||
    existing.ptyIncarnation !== params.ptyIncarnation ||
    existing.processRootId !== params.processRootId ||
    existing.ownerPrincipal !== params.ownerPrincipal ||
    existing.reason !== params.reason
  ) {
    throw new OrchestrationError(
      'mutation_conflict',
      `Close mutation ${params.mutationId} is already bound to another identity.`
    )
  }
}

function deserializeIntent(row: TerminalCloseIntentRow): TerminalCloseIntent {
  let result: unknown = null
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json)
    } catch {
      throw new OrchestrationError('close_intent_result_invalid', 'Close intent result is invalid.')
    }
  }
  return {
    mutationId: row.mutation_id,
    executionHostId: row.execution_host_id,
    workspaceKey: row.workspace_key,
    terminalHandle: row.terminal_handle,
    targetKind: row.target_kind,
    ptyIncarnation: row.pty_incarnation,
    processRootId: row.process_root_id,
    ownerPrincipal: row.owner_principal,
    reason: row.reason,
    state: row.state,
    autoRelease: row.auto_release === 1,
    result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export type TerminalCloseIntentStoreMethods = {
  getTerminalCloseIntent: typeof getTerminalCloseIntent
  assertTerminalCloseIntentAuthority: typeof assertTerminalCloseIntentAuthority
  reserveTerminalCloseIntent: typeof reserveTerminalCloseIntent
  updateTerminalCloseIntent: typeof updateTerminalCloseIntent
}

export function attachTerminalCloseIntentStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getTerminalCloseIntent,
    assertTerminalCloseIntentAuthority,
    reserveTerminalCloseIntent,
    updateTerminalCloseIntent
  })
}
