import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

// The rejection a worker reads when its dispatch capability is gone. An agent
// acts on this text literally, so each branch must report a stored column
// rather than infer a story about who revoked it.
describe('OrchestrationDb', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

describe('revoked dispatch rejection reason', () => {
  // Why direct SQL: these are terminal and interrupted states a settled
  // dispatch cannot be walked into from the public API in one test, and the
  // point of the helper is that it reads the row rather than inferring.
  function revoke(
    d: OrchestrationDb,
    id: string,
    columns: Partial<{
      status: string
      last_failure: string
      failure_count: number
      completed_at: string
    }>
  ): void {
    const sqlite = (d as unknown as { db: Database.Database }).db
    const entries = Object.entries({ ...columns, capability_revoked_at: '2026-01-02 03:04:05' })
    sqlite
      .prepare(
        `UPDATE dispatch_contexts SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`
      )
      .run(...entries.map(([, v]) => v), id)
  }

  function reasonFor(
    columns: Partial<{
      status: string
      last_failure: string
      failure_count: number
      completed_at: string
    }>
  ): string {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const dispatch = d.createDispatchContext(task.id, 'term_worker', 'tab:leaf')
    const capability = d.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab:leaf',
      processIncarnation: 'inc_1'
    })
    revoke(d, dispatch.id, columns)
    const result = d.verifyDispatchCapability({
      dispatchId: dispatch.id,
      capability,
      paneKey: 'tab:leaf',
      processIncarnation: 'inc_1'
    })
    expect(result.valid).toBe(false)
    return (result as { valid: false; reason: string }).reason
  }

  it('names a completed settlement and its time', () => {
    const reason = reasonFor({ status: 'completed', completed_at: '2026-01-02 03:04:05' })
    expect(reason).toContain('was settled as completed')
    expect(reason).toContain('2026-01-02')
  })

  it('carries the recorded cause behind a failed settlement', () => {
    // Why: worker-stop and context-only release both write status 'failed'
    // and keep the real cause in last_failure. Reporting only 'failed' would
    // hide the one column that says what actually happened.
    const reason = reasonFor({ status: 'failed', last_failure: 'stopped' })
    expect(reason).toContain('was settled as failed (stopped)')
  })

  it('names a circuit break rather than calling it a release', () => {
    // Why: circuit_broken is terminal. Any branch that only knows completed
    // and failed misfiles it as something the worker could retry past.
    const reason = reasonFor({ status: 'circuit_broken', failure_count: 3 })
    expect(reason).toContain('circuit-broke after 3 failures')
    expect(reason).not.toContain('settled as')
  })

  it('does not claim a settlement when the capability went first', () => {
    // Why: a stop request revokes the capability while the dispatch is still
    // open, so saying it was settled or released would be a guess.
    const reason = reasonFor({ status: 'dispatched' })
    expect(reason).toContain('revoked')
    expect(reason).toContain('while still dispatched')
    expect(reason).not.toContain('settled')
  })

  it('states the gate scope without promising escalation delivery', () => {
    // Why: whether an escalation reaches a coordinator depends on topology
    // this function cannot see; the gate covering only worker_done and
    // heartbeat is a fact it can state.
    const reason = reasonFor({ status: 'completed' })
    expect(reason).toContain('gates only worker_done and heartbeat')
    expect(reason).toContain('--type escalation')
    expect(reason).toContain('Do not exit with uncommitted work')
  })
})
})
