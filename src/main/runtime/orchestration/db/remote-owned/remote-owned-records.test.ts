import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { claimTaskForStart } from '../tasks/task-start-claim'
import type { RunRow } from '../orchestration-records'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import {
  getRemoteDispatch,
  listRemoteDispatches,
  oweRemoteDispatchStop
} from './remote-dispatch-records'
import { importRemoteOwnedItem, type PulledRemoteOwnedItem } from './remote-owned-import'
import {
  getRemotePlacement,
  recordRemoteStart,
  releaseRemotePlacement,
  reserveRemotePlacement,
  settleRemoteAttemptHere
} from './remote-placements'
import {
  getRemoteRunLink,
  openRemoteRunLink,
  remoteServerPin,
  type RemoteRunLinkRow
} from './remote-run-links'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_b',
  name: 'devB',
  peerFingerprint: 'host_b',
  homePeerFingerprint: 'cred_a',
  pairingRevision: 1
}
const PIN = remoteServerPin(SERVER)
const PEER_RUN = 'run_on_b'

describe('remote-owned records on the coordinating Orca', () => {
  let db: OrchestrationDb
  let run: RunRow
  let link: RemoteRunLinkRow
  let sequence: number

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    run = db.createRun({
      objective: 'Ship',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    link = openRemoteRunLink(db, run.id, SERVER)
    sequence = 0
  })

  afterEach(() => db.close())

  function placeTask(taskId: string, requestKey = `key_${taskId}`, deps?: string[]) {
    return reserveRemotePlacement(db, {
      link,
      taskId,
      requestKey,
      create: { spec: `do ${taskId}`, ...(deps ? { deps } : {}) }
    })
  }

  function startedOnB(taskId: string, dispatchId: string) {
    placeTask(taskId)
    return recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId,
      dispatchId,
      requestKey: `key_${taskId}`,
      peerRunId: PEER_RUN
    })
  }

  function item(
    kind: string,
    payload: Record<string, unknown>,
    at = ++sequence
  ): PulledRemoteOwnedItem {
    return {
      conversationId: link.conversation_id,
      sequence: at,
      messageId: String(payload.id),
      kind,
      payload: JSON.stringify(payload)
    }
  }

  function stateItem(
    dispatchId: string,
    taskId: string,
    change: {
      status?: string
      workerState?: string | null
      taskStatus?: string
      result?: string | null
      corrected?: boolean
      removed?: string
    },
    at?: number
  ) {
    const seq = at ?? ++sequence
    return item(
      'worker_state',
      {
        v: 1,
        id: `state_${seq}`,
        homeRunId: run.id,
        peerRunId: PEER_RUN,
        dispatch: {
          id: dispatchId,
          taskId,
          status: change.status ?? 'dispatched',
          workerState: change.workerState === undefined ? 'ready' : change.workerState,
          lastFailure: null,
          agent: 'claude'
        },
        task: { status: change.taskStatus ?? 'dispatched', result: change.result ?? null },
        correctedUnobservedPrompt: change.corrected ?? false,
        removed: change.removed ? { reason: change.removed } : null
      },
      seq
    )
  }

  function mailItem(
    id: string,
    type: string,
    provenance: { dispatchId: string; taskId: string } | null
  ) {
    return item('worker_mail', {
      v: 1,
      id,
      homeRunId: run.id,
      peerRunId: PEER_RUN,
      message: {
        from: 'dispatch:ctx_b1',
        type,
        subject: `${type} subject`,
        body: 'body',
        payload: null,
        priority: 'normal',
        threadId: null
      },
      dispatchId: provenance?.dispatchId ?? null,
      taskId: provenance?.taskId ?? null
    })
  }

  const importItem = (pulled: PulledRemoteOwnedItem) => importRemoteOwnedItem(db, PIN, pulled)

  describe('a database an unreleased build made', () => {
    it('repairs the placement and record tables on open, so starts and settlements work', () => {
      db.db.exec(`
        DROP TABLE remote_placements;
        CREATE TABLE remote_placements (
          task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, environment_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, state TEXT NOT NULL, request_key TEXT NOT NULL,
          prior_task_status TEXT NOT NULL, dispatch_id TEXT, reserved_by_runtime TEXT NOT NULL,
          outcome_unknown INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ALTER TABLE remote_dispatches DROP COLUMN task_settled_here;
      `)
      db.createTables()

      startedOnB('task_t', 'ctx_b1')
      settleRemoteAttemptHere(db, 'ctx_b1', 'stopped')
      expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ task_settled_here: 1 })
    })
  })

  describe('a retry here of an attempt on the server, by the local rule', () => {
    const retryHere = () => claimTaskForStart(db, db.getTask('task_t')!, { retryOf: 'ctx_b1' })

    it('refuses while a stop is unproven, and follows an abandon here or a proven stop', () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(stateItem('ctx_b1', 'task_t', { status: 'dispatched', workerState: 'ready' }))
      settleRemoteAttemptHere(db, 'ctx_b1', 'stopped')
      expect(db.getTask('task_t')?.status).toBe('blocked')
      // As a local stop_unknown worker: its outcome is unknown, so nothing may follow it yet.
      expect(retryHere).toThrow('Task task_t cannot retry from Dispatch ctx_b1.')

      settleRemoteAttemptHere(db, 'ctx_b1', 'abandoned')
      expect(retryHere).not.toThrow()
    })

    it('follows a stop the server proved', () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(stateItem('ctx_b1', 'task_t', { status: 'dispatched', workerState: 'ready' }))
      settleRemoteAttemptHere(db, 'ctx_b1', 'stopped')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: 'stopped',
          taskStatus: 'blocked'
        })
      )
      expect(retryHere).not.toThrow()
    })
  })

  describe('#5 placement fence', () => {
    it('refuses a local start of a Task being placed on a server, with the ordinary text', () => {
      placeTask('task_t')
      expect(db.getTask('task_t')?.status).toBe('dispatched')
      expect(() =>
        db.createStartingWorkerDispatch({
          taskId: 'task_t',
          startOptions: {},
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER
        })
      ).toThrow('Task task_t is dispatched; only a ready Task can start.')
    })

    it('refuses --task naming another Run', () => {
      const other = db.createRun({
        objective: 'Other',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const foreign = db.createTask({ spec: 'theirs', runId: other.id })
      expect(() =>
        reserveRemotePlacement(db, {
          link,
          taskId: foreign.id,
          requestKey: 'k'
        })
      ).toThrow(`Task ${foreign.id} was not found in Run ${run.id}.`)
      expect(getRemotePlacement(db, foreign.id)).toBeUndefined()
    })

    it('frees the Task only when the server applied nothing, and a same-key retry finds its reservation', () => {
      placeTask('task_t')
      expect(placeTask('task_t').placement.state).toBe('reserved')
      releaseRemotePlacement(db, 'task_t', 'key_task_t')
      expect(getRemotePlacement(db, 'task_t')).toBeUndefined()
      expect(db.getTask('task_t')?.status).toBe('ready')
    })

    it('refuses a start whose deps are unfinished with the ordinary not-ready text', () => {
      const dep = db.createTask({ spec: 'first', runId: run.id })
      expect(() => placeTask('task_t', 'k', [dep.id])).toThrow(
        'Task task_t is pending; only a ready Task can start.'
      )
      expect(db.getTask('task_t')).toBeUndefined()
    })
  })

  describe('a known older attempt never answers a new reservation', () => {
    it('keeps a fresh start fenced and releasable when an item for the earlier attempt arrives', () => {
      startedOnB('task_t', 'ctx_d0')
      importItem(
        stateItem('ctx_d0', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'd0'
        })
      )
      db.updateTaskStatus('task_t', 'ready')
      placeTask('task_t', 'fresh')
      importItem(
        stateItem('ctx_d0', 'task_t', {
          status: 'failed',
          workerState: 'abandoned',
          taskStatus: 'failed',
          result: 'd0'
        })
      )
      expect(getRemotePlacement(db, 'task_t')).toMatchObject({
        state: 'reserved',
        request_key: 'fresh'
      })
      expect(db.getTask('task_t')?.status).toBe('dispatched')
      expect(
        recordRemoteStart(db, {
          conversationId: link.conversation_id,
          taskId: 'task_t',
          dispatchId: 'ctx_d0',
          requestKey: 'fresh'
        })?.dispatch_id
      ).toBe('ctx_d0')
      expect(getRemotePlacement(db, 'task_t')?.state).toBe('reserved')
      releaseRemotePlacement(db, 'task_t', 'fresh')
      expect(db.getTask('task_t')?.status).toBe('ready')
    })
  })

  describe('a re-made pairing', () => {
    it('releases what the old link held, so the Task can be changed here again', () => {
      startedOnB('task_t', 'ctx_b1')
      openRemoteRunLink(db, run.id, {
        ...SERVER,
        homePeerFingerprint: 'cred_a_new',
        pairingRevision: 2
      })
      expect(db.updateTaskStatus('task_t', 'failed', 'pairing re-made')?.status).toBe('failed')
    })
  })

  describe('#3 late facts after a reset', () => {
    for (const reset of ['resetAll', 'resetTasks'] as const) {
      it(`records nothing from a start answer that lands after ${reset}`, () => {
        placeTask('task_t')
        db[reset]()
        expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('cancel_owed')
        expect(
          recordRemoteStart(db, {
            conversationId: link.conversation_id,
            taskId: 'task_t',
            dispatchId: 'ctx_late',
            requestKey: 'key_task_t'
          })
        ).toBeUndefined()
        releaseRemotePlacement(db, 'task_t', 'key_task_t')
        expect(
          importItem(
            stateItem('ctx_late', 'task_t', {
              taskStatus: 'completed',
              status: 'completed',
              workerState: 'succeeded'
            })
          )
        ).toBeUndefined()
        expect(getRemoteDispatch(db, 'ctx_late')).toBeUndefined()
        expect(listRemoteDispatches(db, { runId: run.id, limit: 10 })).toEqual([])
        expect(getRemotePlacement(db, 'task_t')).toBeUndefined()
      })
    }

    it('records nothing from a start answer that lands after the pairing was re-made', () => {
      placeTask('task_t')
      openRemoteRunLink(db, run.id, {
        ...SERVER,
        homePeerFingerprint: 'cred_a_new',
        pairingRevision: 2
      })
      expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('closed')
      expect(
        recordRemoteStart(db, {
          conversationId: link.conversation_id,
          taskId: 'task_t',
          dispatchId: 'ctx_late',
          requestKey: 'key_task_t'
        })
      ).toBeUndefined()
      expect(getRemoteDispatch(db, 'ctx_late')).toBeUndefined()
    })

    it('opens a new link for the Run after a reset, so a later start gets its own cancel', () => {
      db.resetTasks()
      const next = openRemoteRunLink(db, run.id, SERVER)
      expect(next.conversation_id).not.toBe(link.conversation_id)
      expect(getRemoteRunLink(db, link.conversation_id)?.state).toBe('cancel_owed')
    })
  })

  describe('#4 import position', () => {
    it('ignores a redelivered page after a crash before the ack, and a page interrupted midway', () => {
      startedOnB('task_t', 'ctx_b1')
      const first = stateItem('ctx_b1', 'task_t', { workerState: 'ready' })
      const second = mailItem('msg_report', 'worker_done', {
        dispatchId: 'ctx_b1',
        taskId: 'task_t'
      })
      const third = stateItem('ctx_b1', 'task_t', {
        status: 'completed',
        workerState: 'succeeded',
        taskStatus: 'completed',
        result: 'done'
      })
      importItem(first)
      importItem(second)
      // Crash before the ack: the server redelivers the page from the start.
      for (const pulled of [first, second]) {
        expect(importItem(pulled)).toBeUndefined()
      }
      importItem(third)
      expect(db.getTask('task_t')).toMatchObject({ status: 'completed', result: 'done' })
      // An older state redelivered after the newer one changes nothing.
      expect(importItem(first)).toBeUndefined()
      expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({
        worker_state: 'succeeded',
        last_report: 'worker_done subject'
      })
      expect(
        db.getUnreadMessages(`run:${run.id}`).filter((m) => m.id === 'msg_report')
      ).toHaveLength(1)
      expect(getRemoteRunLink(db, link.conversation_id)?.last_imported_sequence).toBe(3)
    })

    it('fails each Task when the server reset removed its Dispatch', () => {
      startedOnB('task_t', 'ctx_b1')
      oweRemoteDispatchStop(db, 'ctx_b1', 'intent_1')
      importItem(stateItem('ctx_b1', 'task_t', { removed: 'Reset on devB.' }))
      expect(db.getTask('task_t')).toMatchObject({ status: 'failed', result: 'Reset on devB.' })
      expect(getRemoteDispatch(db, 'ctx_b1')?.stop_owed).toBe(0)
    })
  })

  describe('#8 settlement through the Task half', () => {
    it('completes the Task from the first success and readies its dependents, writing no local execution rows', () => {
      startedOnB('task_t', 'ctx_b1')
      const dependent = db.createTask({ spec: 'next', runId: run.id, deps: ['task_t'] })
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'shipped'
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'completed', result: 'shipped' })
      expect(db.getTask(dependent.id)?.status).toBe('ready')
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM worker_dispatches').get()).toEqual({ n: 0 })
    })

    it('lets the first result stand: a later failure and a duplicate success are no-ops', () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'first'
        })
      )
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'again'
        })
      )
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'late'
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'completed', result: 'first' })
    })

    it('keeps a late D1 failure from failing a Task reopened under D2', () => {
      startedOnB('task_t', 'ctx_d1')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'failed',
          workerState: 'stopped',
          taskStatus: 'blocked'
        })
      )
      expect(db.getTask('task_t')?.status).toBe('blocked')
      reserveRemotePlacement(db, {
        link,
        taskId: 'task_t',
        requestKey: 'retry',
        retryOf: 'ctx_d1'
      })
      recordRemoteStart(db, {
        conversationId: link.conversation_id,
        taskId: 'task_t',
        dispatchId: 'ctx_d2',
        requestKey: 'retry'
      })
      expect(db.getTask('task_t')?.status).toBe('dispatched')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'failed',
          workerState: 'stopped',
          taskStatus: 'failed',
          result: 'late D1'
        })
      )
      expect(db.getTask('task_t')?.status).toBe('dispatched')
      importItem(
        stateItem('ctx_d2', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'D2'
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'completed', result: 'D2' })
    })

    it("applies the server's unobserved-prompt correction after a failed state item", () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'stalled'
        })
      )
      expect(db.getTask('task_t')?.status).toBe('failed')
      // Without B's decision, a later success is a second result and does not stand.
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'uncorrected'
        })
      )
      expect(db.getTask('task_t')?.status).toBe('failed')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'it worked',
          corrected: true
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'completed', result: 'it worked' })
    })

    it('ignores a late remote result once the Task was started here', () => {
      startedOnB('task_t', 'ctx_d1')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'failed',
          workerState: 'stopped',
          taskStatus: 'blocked'
        })
      )
      db.updateTaskStatus('task_t', 'ready')
      const local = createRootDispatch(db, 'task_t', 'term_local')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'failed',
          workerState: 'stopped',
          taskStatus: 'failed',
          result: 'late D1'
        })
      )
      expect(db.getTask('task_t')?.status).toBe('dispatched')
      expect(db.getDispatchContextById(local.id)?.status).toBe('dispatched')
    })

    it('counts a remote attempt as the Task’s active worker for local Task updates', () => {
      startedOnB('task_t', 'ctx_b1')
      expect(() => db.updateTaskStatus('task_t', 'completed', 'by hand')).toThrow(
        'Task task_t cannot move to completed while supervised Dispatch ctx_b1 is active'
      )
    })
  })

  describe('a local claim takes the Task back', () => {
    it('keeps a late correction of an older remote attempt off a Task a local manual Dispatch settled', () => {
      startedOnB('task_t', 'ctx_d1')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'stalled'
        })
      )
      db.updateTaskStatus('task_t', 'ready')
      const local = createRootDispatch(db, 'task_t', 'term_local')
      expect(getRemotePlacement(db, 'task_t')).toBeUndefined()
      db.updateTaskStatus('task_t', 'failed', 'local D2 failure')
      expect(db.getDispatchContextById(local.id)?.status).toBe('failed')
      importItem(
        stateItem('ctx_d1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'old D1 correction',
          corrected: true
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'failed', result: 'local D2 failure' })
    })

    it('lets a local start through once the pairing behind a reservation was re-made', () => {
      placeTask('task_t')
      openRemoteRunLink(db, run.id, {
        ...SERVER,
        homePeerFingerprint: 'cred_a_new',
        pairingRevision: 2
      })
      db.updateTaskStatus('task_t', 'ready')
      const started = db.createStartingWorkerDispatch({
        taskId: 'task_t',
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER
      })
      expect(started.task.status).toBe('dispatched')
      expect(getRemotePlacement(db, 'task_t')).toBeUndefined()
    })
  })

  describe('Task guards', () => {
    it('refuses a decision gate on a Task a remote worker still holds', () => {
      startedOnB('task_t', 'ctx_b1')
      expect(() => db.createGate({ taskId: 'task_t', question: 'Ship?' })).toThrow(
        'Task task_t cannot open a gate while supervised Dispatch ctx_b1 is active'
      )
    })

    it('keeps holding a Task whose worker finished until its result comes home', () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'dispatched',
          workerState: 'succeeded',
          taskStatus: 'dispatched'
        })
      )
      expect(() => db.updateTaskStatus('task_t', 'completed', 'by hand')).toThrow(
        'ctx_b1 is active'
      )
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'circuit_broken',
          workerState: null,
          taskStatus: 'dispatched'
        })
      )
      expect(() => db.updateTaskStatus('task_t', 'failed', 'by hand')).toThrow('ctx_b1 is active')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: null,
          taskStatus: 'failed',
          result: 'from the server'
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'failed', result: 'from the server' })
    })

    it('refuses a local retry of an older local attempt once a server attempt is the latest', () => {
      const task = db.createTask({ spec: 'work', runId: run.id })
      const d1 = db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER
      })
      db.failWorkerStart(d1.dispatch.id, 'agent_readiness', 'local failed')
      db.updateTaskStatus(task.id, 'ready')
      reserveRemotePlacement(db, {
        link,
        taskId: task.id,
        requestKey: 'remote'
      })
      recordRemoteStart(db, {
        conversationId: link.conversation_id,
        taskId: task.id,
        dispatchId: 'ctx_d2',
        requestKey: 'remote'
      })
      importItem(
        stateItem('ctx_d2', task.id, {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'remote failed'
        })
      )
      expect(db.getTask(task.id)?.status).toBe('failed')
      expect(() =>
        db.createStartingWorkerDispatch({
          taskId: task.id,
          retryOf: d1.dispatch.id,
          startOptions: {},
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER
        })
      ).toThrow(`Task ${task.id} cannot retry from Dispatch ${d1.dispatch.id}.`)
    })

    it('reclaims a same-key retry under the new link after a re-pair', () => {
      placeTask('task_t', 'k')
      const next = openRemoteRunLink(db, run.id, {
        ...SERVER,
        homePeerFingerprint: 'cred_a_new',
        pairingRevision: 2
      })
      db.updateTaskStatus('task_t', 'ready')
      const retried = reserveRemotePlacement(db, {
        link: next,
        taskId: 'task_t',
        requestKey: 'k'
      })
      expect(retried.placement).toMatchObject({
        conversation_id: next.conversation_id,
        state: 'reserved'
      })
      expect(retried.task.status).toBe('dispatched')
    })

    it("takes the server's corrected failure text", () => {
      startedOnB('task_t', 'ctx_b1')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'stalled'
        })
      )
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'failed',
          workerState: 'failed',
          taskStatus: 'failed',
          result: 'real failure',
          corrected: true
        })
      )
      expect(db.getTask('task_t')).toMatchObject({ status: 'failed', result: 'real failure' })
    })
  })

  describe('S3 / S8 queue items', () => {
    it('lets a late start answer seed identity only, never state', () => {
      placeTask('task_t')
      importItem(
        stateItem('ctx_b1', 'task_t', {
          status: 'completed',
          workerState: 'succeeded',
          taskStatus: 'completed',
          result: 'r'
        })
      )
      recordRemoteStart(db, {
        conversationId: link.conversation_id,
        taskId: 'task_t',
        dispatchId: 'ctx_b1',
        requestKey: 'key_task_t',
        agent: 'codex'
      })
      expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({
        status: 'completed',
        worker_state: 'succeeded'
      })
      expect(db.getTask('task_t')?.status).toBe('completed')
    })

    it('creates the record of a Dispatch it never heard of from the item, and adopts it as the placement’s attempt', () => {
      placeTask('task_t')
      importItem(stateItem('ctx_unseen', 'task_t', { status: 'pending', workerState: 'starting' }))
      expect(getRemoteDispatch(db, 'ctx_unseen')).toMatchObject({
        task_id: 'task_t',
        run_id: run.id,
        worker_state: 'starting'
      })
      expect(getRemotePlacement(db, 'task_t')).toMatchObject({
        state: 'accepted',
        dispatch_id: 'ctx_unseen'
      })
    })

    it('refuses an item whose message ID, Run, peer Run or kind does not match, leaving the position', () => {
      startedOnB('task_t', 'ctx_b1')
      const good = stateItem('ctx_b1', 'task_t', {})
      expect(() => importItem({ ...good, messageId: 'other' })).toThrow('was not imported')
      const wrongPeer = JSON.parse(good.payload)
      expect(() =>
        importItem({
          ...good,
          payload: JSON.stringify({ ...wrongPeer, peerRunId: 'run_elsewhere' })
        })
      ).toThrow('peer Run')
      expect(() =>
        importItem({ ...good, payload: JSON.stringify({ ...wrongPeer, homeRunId: 'run_other' }) })
      ).toThrow('belongs to Run')
      expect(() => importItem({ ...good, kind: 'worker_future' })).toThrow('kind worker_future')
      expect(() => importItem({ ...good, payload: '{"v":2}' })).toThrow('does not match')
      expect(getRemoteRunLink(db, link.conversation_id)?.last_imported_sequence).toBe(0)
      importItem(good)
      expect(getRemoteRunLink(db, link.conversation_id)?.last_imported_sequence).toBe(good.sequence)
    })

    it('records the question a remote worker asked, and files its mail in the Run mailbox', () => {
      startedOnB('task_t', 'ctx_b1')
      expect(
        importItem(mailItem('msg_q', 'question', { dispatchId: 'ctx_b1', taskId: 'task_t' }))
      ).toEqual({ to: `run:${run.id}`, type: 'question' })
      expect(
        db.db
          .prepare(
            'SELECT dispatch_id, environment_id FROM remote_owned_questions WHERE message_id = ?'
          )
          .get('msg_q')
      ).toEqual({ dispatch_id: 'ctx_b1', environment_id: 'env_b' })
      expect(db.getUnreadMessages(`run:${run.id}`)).toEqual([
        expect.objectContaining({
          id: 'msg_q',
          type: 'question',
          from_handle: 'dispatch:ctx_b1',
          body: 'body'
        })
      ])
    })
  })
})
