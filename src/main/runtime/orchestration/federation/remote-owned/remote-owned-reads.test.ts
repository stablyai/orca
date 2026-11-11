import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { RunRow } from '../../db/orchestration-records'
import { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import {
  getRemoteDispatch,
  recordRemoteDispatchReport,
  recordRemoteDispatchState
} from '../../db/remote-owned/remote-dispatch-records'
import { recordRemoteStart, reserveRemotePlacement } from '../../db/remote-owned/remote-placements'
import { openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { ORCHESTRATION_WORKER_LIST_METHOD } from '../../../rpc/methods/orchestration/worker/worker-list-method'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_b',
  name: 'devB',
  peerFingerprint: 'host_b',
  homePeerFingerprint: 'cred_a',
  pairingRevision: 1
}
const LAST_HEARD = '2026-11-09 08:30:00'

describe('reads of workers a paired server runs, from this Orca’s records', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let run: RunRow

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation((selector) => {
      if (selector !== SERVER.environmentId) {
        throw new OrchestrationError('server_not_found', `No server ${selector}.`)
      }
      return SERVER
    })
    run = db.createRun({
      objective: 'Ship',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  /** A worker devB started for Task `taskId`, as devB last reported it at LAST_HEARD. */
  function remoteWorker(taskId: string, dispatchId: string, environmentId = SERVER.environmentId) {
    const link = openRemoteRunLink(db, run.id, { ...SERVER, environmentId })
    reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey: `key_${taskId}`,
      create: { spec: `do ${taskId}` }
    })
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId,
      dispatchId,
      requestKey: `key_${taskId}`,
      peerRunId: 'run_on_b'
    })
    recordRemoteDispatchState(db, dispatchId, {
      status: 'dispatched',
      worker_state: 'ready',
      last_failure: null,
      agent: 'claude'
    })
    recordRemoteDispatchReport(db, dispatchId, 'Halfway: tests written.')
    db.db.prepare('UPDATE remote_dispatches SET updated_at = ?').run(LAST_HEARD)
    return getRemoteDispatch(db, dispatchId)!
  }

  type ListedWorkers = {
    workers: { dispatchId: string; server?: Record<string, unknown> }[]
    page: { total: number; hasMore: boolean; nextCursor: string | null }
    warnings?: string[]
  }

  async function listWorkers(params: Record<string, unknown>): Promise<ListedWorkers> {
    const parsed = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse(params)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method returns the list shape the CLI reads.
    return (await ORCHESTRATION_WORKER_LIST_METHOD.handler(parsed, {
      runtime
    } as never)) as ListedWorkers
  }

  it('lists remote workers on the first page beside local ones, named by their server, and nowhere else', async () => {
    remoteWorker('task_1', 'ctx_w1')
    remoteWorker('task_2', 'ctx_w2')

    const first = await listWorkers({ run: run.id, paginate: true })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['ctx_w2', 'ctx_w1'])
    expect(first.page).toMatchObject({ total: 2, hasMore: false })
    expect(first.workers[0]).toMatchObject({
      dispatchId: 'ctx_w2',
      workerState: 'ready',
      server: { name: 'devB', asOf: '2026-11-09T08:30:00Z' }
    })

    // A later page follows this Orca's own cursor and repeats none of them.
    for (let index = 0; index < 101; index += 1) {
      const task = db.createTask({ spec: `local ${index}`, runId: run.id })
      db.db
        .prepare(
          `INSERT INTO dispatch_contexts (id, run_id, task_id, assignee_handle, status, created_at)
           VALUES (?, ?, ?, ?, 'dispatched', '2026-11-01 00:00:00')`
        )
        .run(`ctx_local_${String(index).padStart(3, '0')}`, run.id, task.id, `term_${index}`)
    }
    const mixed = await listWorkers({ run: run.id, paginate: true })
    expect(mixed.workers).toHaveLength(102)
    expect(mixed.workers.slice(-2).map((worker) => worker.dispatchId)).toEqual(['ctx_w2', 'ctx_w1'])
    expect(mixed.page).toMatchObject({ total: 103, hasMore: true })
    const next = await listWorkers({ run: run.id, paginate: true, cursor: mixed.page?.nextCursor })
    expect(next.page).toMatchObject({ total: 103 })
    expect(next.workers.map((worker) => worker.dispatchId)).toEqual([
      expect.stringMatching(/^ctx_local_/)
    ])

    // Only devB knows their terminals; another Run's list has none of them.
    const filtered = await listWorkers({ run: run.id, paginate: true, terminalState: 'retained' })
    expect(filtered.workers.map((worker) => worker.dispatchId)).not.toContain('ctx_w1')
    expect(filtered.page).toMatchObject({ total: 101 })
    const other = db.createRun({
      objective: 'Other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: null
    })
    expect((await listWorkers({ run: other.id, paginate: true })).workers).toEqual([])
  })
})
