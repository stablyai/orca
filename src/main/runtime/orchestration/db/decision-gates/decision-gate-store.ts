import type { DecisionGateRow, DispatchContextRow, GateStatus } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_RUN_ID } from '../contract-constants'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Decision Gates ──

export function createGate(
  this: OrchestrationDb,
  gate: {
    taskId: string
    question: string
    options?: string[]
    requester?: { handle: string; paneKey?: string | null; dispatchId: string }
  }
): DecisionGateRow {
  this.db.exec('SAVEPOINT create_gate')
  try {
    const active = this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE task_id = ? AND status IN ('pending', 'dispatched')
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(gate.taskId) as DispatchContextRow | undefined
    if (
      gate.requester &&
      (!active ||
        active.id !== gate.requester.dispatchId ||
        !this.isDispatchMessageSender({
          dispatchId: active.id,
          handle: gate.requester.handle,
          paneKey: gate.requester.paneKey,
          allowCanonicalDispatchHandle: true
        }))
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Terminal ${gate.requester.handle} does not own the active Dispatch for Task ${gate.taskId}.`,
        { taskId: gate.taskId, dispatchId: active?.id }
      )
    }
    const activeWorker = this.db
      .prepare(
        `SELECT active.id
         FROM dispatch_contexts active
         JOIN worker_dispatches worker ON worker.dispatch_id = active.id
         WHERE active.task_id = ? AND active.status IN ('pending', 'dispatched')
           AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
         ORDER BY active.rowid DESC LIMIT 1`
      )
      .get(gate.taskId) as { id: string } | undefined
    if (activeWorker) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${gate.taskId} cannot open a gate while supervised Dispatch ${activeWorker.id} is active; stop or settle its worker first.`,
        { taskId: gate.taskId, dispatchId: activeWorker.id }
      )
    }
    const id = generateId('gate')
    const optionsJson = JSON.stringify(gate.options ?? [])
    this.db
      .prepare(
        'INSERT INTO decision_gates (id, run_id, task_id, question, options) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        id,
        this.getTask(gate.taskId)?.run_id ?? LEGACY_RUN_ID,
        gate.taskId,
        gate.question,
        optionsJson
      )
    this.completeActiveDispatchesForTask(gate.taskId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(gate.taskId)
    const created = this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as
      | DecisionGateRow
      | undefined
    this.db.exec('RELEASE create_gate')
    return created as DecisionGateRow
  } catch (error) {
    this.db.exec('ROLLBACK TO create_gate')
    this.db.exec('RELEASE create_gate')
    throw error
  }
}

export function resolveGate(
  this: OrchestrationDb,
  gateId: string,
  resolution: string
): DecisionGateRow | undefined {
  const gate = this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
    | DecisionGateRow
    | undefined
  if (!gate) {
    return undefined
  }

  this.db.exec('SAVEPOINT resolve_gate')
  try {
    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?"
      )
      .run(resolution, gateId)
    this.updateTaskStatus(gate.task_id, 'ready')
    const resolved = this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
    this.db.exec('RELEASE resolve_gate')
    return resolved
  } catch (error) {
    this.db.exec('ROLLBACK TO resolve_gate')
    this.db.exec('RELEASE resolve_gate')
    throw error
  }
}

export function timeoutGate(this: OrchestrationDb, gateId: string): DecisionGateRow | undefined {
  this.db
    .prepare(
      // Why: without the status guard a late timeout overwrites a gate the user already resolved.
      "UPDATE decision_gates SET status = 'timeout', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
    .run(gateId)
  return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
    | DecisionGateRow
    | undefined
}

export function listGates(
  this: OrchestrationDb,
  filter?: { taskId?: string; status?: GateStatus }
): DecisionGateRow[] {
  if (filter?.taskId && filter?.status) {
    return this.db
      .prepare('SELECT * FROM decision_gates WHERE task_id = ? AND status = ? ORDER BY created_at')
      .all(filter.taskId, filter.status) as DecisionGateRow[]
  }
  if (filter?.taskId) {
    return this.db
      .prepare('SELECT * FROM decision_gates WHERE task_id = ? ORDER BY created_at')
      .all(filter.taskId) as DecisionGateRow[]
  }
  if (filter?.status) {
    return this.db
      .prepare('SELECT * FROM decision_gates WHERE status = ? ORDER BY created_at')
      .all(filter.status) as DecisionGateRow[]
  }
  return this.db
    .prepare('SELECT * FROM decision_gates ORDER BY created_at')
    .all() as DecisionGateRow[]
}

export function getGate(this: OrchestrationDb, id: string): DecisionGateRow | undefined {
  return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as
    | DecisionGateRow
    | undefined
}

export type DecisionGateStoreMethods = {
  createGate: typeof createGate
  resolveGate: typeof resolveGate
  timeoutGate: typeof timeoutGate
  listGates: typeof listGates
  getGate: typeof getGate
}

export function attachDecisionGateStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createGate,
    resolveGate,
    timeoutGate,
    listGates,
    getGate
  })
}
