import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../../../sqlite/sync-database'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { DISPATCH_HEARTBEAT_STALE_AFTER_MS } from '../../../../../../shared/orchestration-heartbeat-freshness'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'

type HeartbeatListResult = {
  workers: {
    dispatchId: string
    projection: {
      liveness: { verdict: string }
      heartbeat?: { state: string; lastReceivedAt: number | null; ageSeconds: number | null }
    }
  }[]
}

describe('orchestration worker-list heartbeat freshness', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('ages every Dispatch of one listing against this host clock', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Heartbeat freshness inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'ctx_silent')
    insertDispatch(db, run.id, 'ctx_reporting')
    insertDispatch(db, run.id, 'ctx_hung')
    const now = Date.now()
    db.recordHeartbeat('ctx_reporting', new Date(now - 20_000).toISOString())
    db.recordHeartbeat(
      'ctx_hung',
      new Date(now - DISPATCH_HEARTBEAT_STALE_AFTER_MS - 60_000).toISOString()
    )

    const result = await callWorkerList(runtime, { run: run.id, paginate: true })
    const byDispatch = new Map(result.workers.map((worker) => [worker.dispatchId, worker]))

    expect(byDispatch.get('ctx_silent')?.projection.heartbeat).toEqual({
      state: 'none',
      lastReceivedAt: null,
      ageSeconds: null
    })
    const reporting = byDispatch.get('ctx_reporting')?.projection.heartbeat
    expect(reporting?.state).toBe('fresh')
    expect(reporting?.ageSeconds).toBeGreaterThanOrEqual(20)
    expect(reporting?.ageSeconds).toBeLessThan(60)
    expect(byDispatch.get('ctx_hung')?.projection.heartbeat?.state).toBe('stale')
  })

  // Why: a lane can be reporting on the protocol while nothing certifies its process, and the
  // reverse. Collapsing the two would let one silence the other.
  it('keeps the freshness independent of the liveness verdict', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Heartbeat beside liveness',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    insertDispatch(db, run.id, 'ctx_reporting')
    db.recordHeartbeat('ctx_reporting', new Date().toISOString())

    const result = await callWorkerList(runtime, { run: run.id, paginate: true })
    const worker = result.workers[0]?.projection

    expect(worker?.liveness.verdict).toBe('unverifiable')
    expect(worker?.heartbeat?.state).toBe('fresh')
  })

  // Why: SQLite stores UTC in the timezone-less space format, so a stamp read back raw would
  // parse as local time and report an age off by the host's offset.
  it('reads a space-format stamp as UTC', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stored stamp format',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    insertDispatch(db, run.id, 'ctx_space_format')
    const storedAt = new Date(Date.now() - 60_000).toISOString()
    db.recordHeartbeat('ctx_space_format', `${storedAt.slice(0, 10)} ${storedAt.slice(11, 23)}`)

    const result = await callWorkerList(runtime, { run: run.id, paginate: true })
    const heartbeat = result.workers[0]?.projection.heartbeat

    expect(heartbeat?.state).toBe('fresh')
    expect(heartbeat?.ageSeconds).toBeGreaterThanOrEqual(60)
    expect(heartbeat?.ageSeconds).toBeLessThan(120)
  })

  // Why: `Date.parse` failing used to collapse into the same `null` a never-dispatched heartbeat
  // uses, so a corrupt row was published as "never reported" — the one reading a coordinator
  // cannot act on. Corruption has to be its own word.
  it('reports a stored stamp it cannot parse as unreadable, not as never reported', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Corrupt arrival stamp',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    })
    insertDispatch(db, run.id, 'ctx_silent')
    insertDispatch(db, run.id, 'ctx_corrupt')
    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ?')
      .run('not-a-timestamp', 'ctx_corrupt')

    const result = await callWorkerList(runtime, { run: run.id, paginate: true })
    const byDispatch = new Map(result.workers.map((worker) => [worker.dispatchId, worker]))

    expect(byDispatch.get('ctx_corrupt')?.projection.heartbeat).toEqual({
      state: 'unreadable',
      lastReceivedAt: null,
      ageSeconds: null
    })
    expect(byDispatch.get('ctx_silent')?.projection.heartbeat?.state).toBe('none')
  })

  // Why: SQL NULL is the only "never written". An empty string is a value that was stored and lost
  // its contents, and reporting that as `none` would blame the coordinator's own protocol.
  it('reports an empty stored stamp as unreadable rather than never reported', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Empty arrival stamp',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
    insertDispatch(db, run.id, 'ctx_empty')
    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ?')
      .run('', 'ctx_empty')

    const result = await callWorkerList(runtime, { run: run.id, paginate: true })

    expect(result.workers[0]?.projection.heartbeat?.state).toBe('unreadable')
  })
})

async function callWorkerList(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>
): Promise<HeartbeatListResult> {
  const parsed = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse(params)
  return (await ORCHESTRATION_WORKER_LIST_METHOD.handler(parsed, {
    runtime
  })) as HeartbeatListResult
}

function insertDispatch(db: OrchestrationDb, runId: string, dispatchId: string): void {
  const task = db.createTask({ spec: dispatchId, runId })
  sqliteFor(db)
    .prepare(
      `INSERT INTO dispatch_contexts (
         id, run_id, task_id, assignee_handle, status, created_at
       ) VALUES (?, ?, ?, ?, 'dispatched', '2026-08-27 00:00:00')`
    )
    .run(dispatchId, runId, task.id, `term-${dispatchId}`)
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}
