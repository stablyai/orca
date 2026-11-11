import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { claimTaskForStart } from '../tasks/task-start-claim'
import type { RunRow } from '../orchestration-records'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { getRemoteDispatch, listRemoteDispatches } from './remote-dispatch-records'
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
  })

  describe('#8 settlement through the Task half', () => {
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
  })
})
