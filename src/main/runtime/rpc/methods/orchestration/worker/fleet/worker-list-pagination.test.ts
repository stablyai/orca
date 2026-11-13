import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../../../../sqlite/sync-database'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import type { FederatedDispatchRow } from '../../../../../orchestration/db/orchestration-records'
import { OrcaRuntimeService } from '../../../../../orca-runtime'
import { encodeWorkerListCursor } from './worker-list-cursor'
import { ORCHESTRATION_WORKER_LIST_METHOD } from '../worker-list-method'

type WorkerListResult = {
  workers: {
    dispatchId: string
    projection: { attention: { categories: string[] } }
  }[]
  counts: Record<string, number>
  page: { total: number; hasMore: boolean; nextCursor: string | null }
  warnings?: string[]
}

describe('orchestration worker-list pagination', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('opens on the newest Dispatches, warns that the page truncated, and pages down', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Newest-first worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const id = (index: number): string => `dispatch-${String(index).padStart(3, '0')}`
    for (let index = 1; index <= 105; index += 1) {
      insertDispatch(db, run.id, id(index))
    }

    const first = await callWorkerList(runtime, { run: run.id, paginate: true })

    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(
      Array.from({ length: 100 }, (_, offset) => id(105 - offset))
    )
    expect(first.page).toMatchObject({ total: 105, hasMore: true })
    expect(first.warnings).toEqual([
      'Showing 100 of 105 Dispatches, newest first; more are on later pages. Follow page.nextCursor with --cursor.'
    ])
    expect(first.counts).toEqual({ retained: 105 })

    insertDispatch(db, run.id, 'dispatch-after-first-call')
    const second = await callWorkerList(runtime, {
      run: run.id,
      paginate: true,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual([5, 4, 3, 2, 1].map(id))
    expect(second.page).toEqual({ total: 105, limit: 100, hasMore: false, nextCursor: null })
    expect(second.warnings).toBeUndefined()
    expect(second.counts).toEqual({ retained: 105 })
  })

  it('keeps filtered snapshot membership when a later worker changes state', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(first.page).toMatchObject({ total: 2, hasMore: true })

    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET assignee_handle = NULL WHERE id = ?')
      .run('dispatch-a')
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(second.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
    // The pinned total and the counts have to describe the same rows.
    expect(second.counts).toEqual({ retained: second.page.total })
  })

  it('keeps an include-remote filtered page pinned across 32 concurrent snapshot allocations', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Pinned filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    vi.spyOn(db, 'listFederatedDispatchesByIds').mockImplementation((dispatchIds) =>
      dispatchIds.includes('dispatch-z') ? [federatedDispatch('dispatch-z')] : []
    )
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment-remote',
      name: 'remote',
      peerFingerprint: 'peer-remote',
      pairingRevision: 1
    })
    let resolveSnapshot!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      resolveSnapshot = resolve
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async () => {
        await snapshotGate
        return {
          runtimeEpoch: 'epoch-remote',
          items: [
            {
              dispatchId: 'dispatch-z',
              observation: { status: 'live', exactWorker: true }
            }
          ]
        }
      })

    const pending = callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      includeRemote: true,
      limit: 1
    })
    await vi.waitFor(() =>
      expect(remoteCall).toHaveBeenCalledWith(
        'environment-remote',
        'orchestration.federationFleetSnapshot',
        { dispatchIds: ['dispatch-z'] },
        expect.any(Number),
        undefined,
        { expectedEnvironmentPairingRevision: 1 }
      )
    )
    for (let call = 0; call < 32; call += 1) {
      await callWorkerList(runtime, { run: run.id, terminalState: 'retained', limit: 1 })
    }
    resolveSnapshot()

    const first = await pending
    expect(first).toMatchObject({
      workers: [{ dispatchId: 'dispatch-z' }],
      page: { total: 2, hasMore: true, nextCursor: expect.any(String) }
    })
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
  })

  it('never re-emits a row whose worker registers between pages', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable order key',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const result: WorkerListResult = await callWorkerList(runtime, {
        run: run.id,
        limit: 1,
        ...(cursor ? { cursor } : {})
      })
      seen.push(...result.workers.map((worker) => worker.dispatchId))
      if (page === 0) {
        // A worker row lands for the page-1 row; its COALESCE(created_at) sort key moves forward.
        sqliteFor(db)
          .prepare(
            `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, created_at)
             VALUES (?, 'ready', 'ready', ?, '2026-08-27 01:00:00')`
          )
          .run('dispatch-a', 'term-dispatch-a')
      }
      cursor = result.page.nextCursor
      if (!cursor) {
        break
      }
    }

    expect(seen).toEqual(['dispatch-z', 'dispatch-a'])
  })

  describe('a legacy cursor anchored outside the requested Run', () => {
    function twoRuns(): { runA: string; runB: string } {
      db = new OrchestrationDb(':memory:')
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term-a',
        coordinatorPaneKey: 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term-b',
        coordinatorPaneKey: 'tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
      insertDispatch(db, runA.id, 'a-1')
      insertDispatch(db, runA.id, 'a-2')
      insertDispatch(db, runB.id, 'b-1')
      insertDispatch(db, runB.id, 'b-2')
      return { runA: runA.id, runB: runB.id }
    }

    // Both shapes used to resolve to a rowid past Run A's rows and report a finished, empty page.

    it('expires a v2 cursor that carries a foreign rowid', async () => {
      const { runA } = twoRuns()
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db!)
      const foreign = encodeWorkerListCursor({
        version: 2,
        snapshot: { databaseId: 4 },
        after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'b-1', databaseId: 3 }
      })

      await expect(
        callWorkerList(runtime, { run: runA, limit: 10, cursor: foreign })
      ).rejects.toThrow(/changed destructively/u)
    })
  })
})

async function callWorkerList(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>
): Promise<WorkerListResult> {
  const parsed = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse(params)
  return (await ORCHESTRATION_WORKER_LIST_METHOD.handler(parsed, { runtime })) as WorkerListResult
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

function federatedDispatch(dispatchId: string): FederatedDispatchRow {
  return {
    dispatch_id: dispatchId,
    environment_id: 'environment-remote',
    environment_name: 'remote',
    peer_fingerprint: 'peer-remote',
    remote_runtime_epoch: 'epoch-remote',
    protocol_version: 3,
    remote_worktree_id: null,
    remote_terminal_handle: null,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0,
    home_auto_release_at: null,
    home_auto_release_state: null,
    created_at: '2026-08-27 00:00:00',
    updated_at: '2026-08-27 00:00:00'
  }
}
