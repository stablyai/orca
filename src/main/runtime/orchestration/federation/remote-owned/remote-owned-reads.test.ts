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
  oweRemoteDispatchStop,
  recordRemoteDispatchReport,
  recordRemoteDispatchState
} from '../../db/remote-owned/remote-dispatch-records'
import { recordRemoteStart, reserveRemotePlacement } from '../../db/remote-owned/remote-placements'
import { closeRemoteRunLink, openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { ORCHESTRATION_WORKER_LIST_METHOD } from '../../../rpc/methods/orchestration/worker/worker-list-method'
import { offlineRemoteWorkerShow } from './remote-owned-reads'
import { explainRemoteServerFailure } from './remote-server-unreachable'

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

  afterEach(() => db.close())

  /** A worker devB started for Task `taskId`, as devB last reported it at LAST_HEARD. */
  function remoteWorker(taskId: string, dispatchId: string, environmentId = SERVER.environmentId) {
    const link = openRemoteRunLink(db, run.id, { ...SERVER, environmentId })
    reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey: `key_${taskId}`,
      runtimeId: 'runtime_a',
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

  it('shows an unreachable server’s worker in the ordinary shape, labelled with its server and last report', () => {
    const shown = offlineRemoteWorkerShow(runtime, remoteWorker('task_1', 'ctx_w1'))

    expect(shown).toMatchObject({
      dispatch: { id: 'ctx_w1', taskId: 'task_1', runId: run.id, status: 'dispatched' },
      worker: { dispatchId: 'ctx_w1', state: 'ready', stage: 'server_unreachable' },
      server: { name: 'devB', reachable: false, asOf: '2026-11-09T08:30:00Z' },
      lastReport: 'Halfway: tests written.'
    })
    expect(shown.observation.reason).toContain('devB could not be reached')
  })

  it('keeps the time devB last reported when this Orca only owes it a stop', () => {
    const record = remoteWorker('task_1', 'ctx_w1')
    oweRemoteDispatchStop(db, record.dispatch_id, 'intent_1')

    const shown = offlineRemoteWorkerShow(runtime, getRemoteDispatch(db, 'ctx_w1')!)
    expect(shown.server.asOf).toBe('2026-11-09T08:30:00Z')
    expect(shown.observation.reason).toContain('A stop is owed')
  })

  it('says a re-made pairing, not an unreachable server, left the record', async () => {
    const record = remoteWorker('task_1', 'ctx_w1')
    closeRemoteRunLink(db, record.conversation_id, 'The pairing with this server was re-made.')

    const shown = offlineRemoteWorkerShow(runtime, record)
    expect(shown.server).toMatchObject({ name: 'devB', repaired: true })
    expect(shown.observation.reason).toContain('The pairing with devB was re-made')
    const listed = await listWorkers({ run: run.id, paginate: true })
    expect(listed.workers).toEqual([
      expect.objectContaining({
        dispatchId: 'ctx_w1',
        server: expect.objectContaining({ name: 'devB', repaired: true })
      })
    ])
  })

  it('keeps remote rows within the page limit and counts the rest in the total', async () => {
    remoteWorker('task_1', 'ctx_w1')
    remoteWorker('task_2', 'ctx_w2')

    const page = await listWorkers({ run: run.id, paginate: true, limit: 1 })
    expect(page.workers.map((worker) => worker.dispatchId)).toEqual(['ctx_w2'])
    expect(page.page).toMatchObject({ total: 2 })
    expect(page.warnings).toEqual(['Showing the newest 1 of 2 workers on paired servers.'])
  })

  it('names a server removed since by its environment ID', () => {
    const shown = offlineRemoteWorkerShow(runtime, remoteWorker('task_1', 'ctx_w1', 'env_gone'))
    expect(shown.server.name).toBe('env_gone')
  })

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

  it('says a server that never answered cannot confirm a change, and passes its own unknown outcome through', () => {
    const offline = new OrchestrationError(
      'remote_runtime_unavailable',
      'Could not connect to the remote Orca runtime.'
    )
    const change = explainRemoteServerFailure(offline, {
      server: 'devB',
      method: 'orchestration.workerRelease',
      params: { dispatch: 'ctx_w1' },
      dispatchId: 'ctx_w1'
    })
    expect(change).toMatchObject({
      code: 'remote_runtime_unavailable',
      data: { server: 'devB', reachable: false }
    })
    expect(change).toHaveProperty(
      'message',
      expect.stringContaining(
        'devB did not answer (Could not connect to the remote Orca runtime.), so this Orca cannot tell whether the command reached it.'
      )
    )
    expect(change).toHaveProperty(
      'message',
      expect.stringContaining('Retry only with the same request ID (--retry-request)')
    )

    const read = explainRemoteServerFailure(
      new OrchestrationError('runtime_timeout', 'Timed out.'),
      {
        server: 'devB',
        method: 'orchestration.workerRead',
        params: { dispatch: 'ctx_w1' },
        dispatchId: 'ctx_w1'
      }
    )
    expect(read).toMatchObject({ code: 'runtime_timeout' })
    expect(read).toHaveProperty(
      'message',
      expect.stringContaining('devB could not be reached (Timed out.)')
    )
    expect(read).toHaveProperty(
      'message',
      expect.stringContaining('its output is kept only on devB')
    )

    const unknown = new OrchestrationError('operation_unknown', 'The stop is still pending.')
    expect(
      explainRemoteServerFailure(unknown, {
        server: 'devB',
        method: 'orchestration.workerStop',
        params: { dispatch: 'ctx_w1' }
      })
    ).toBe(unknown)
  })
})
