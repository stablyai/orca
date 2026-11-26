import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { reconcileLifecycleMessage } from '../../workers/lifecycle/lifecycle-reconciliation'
import { importRemoteOwnedItem } from './remote-owned-import'
import { adoptRemoteAttempt, recordRemoteStart, reserveRemotePlacement } from './remote-placements'
import { openRemoteRunLink, remoteServerPin, type RemoteRunLinkRow } from './remote-run-links'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'Server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const TASK = 'task_0123456789ab'
const KEY = 'start-key'

// A worker_done sent on the paired server, queued home by the server's own trigger, and reread by mail delivery here.
describe('worker_done from a worker on a paired server', () => {
  let home: OrchestrationDb
  let server: OrchestrationDb
  let link: RemoteRunLinkRow
  let peerRunId: string

  beforeEach(() => {
    home = new OrchestrationDb(':memory:')
    server = new OrchestrationDb(':memory:')
    const homeRunId = home.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    }).id
    link = openRemoteRunLink(home, homeRunId, SERVER)
    reserveRemotePlacement(home, { link, taskId: TASK, requestKey: KEY, create: { spec: 'work' } })
    peerRunId = server.admitPeerRun({
      peerFingerprint: 'fp_home',
      peerRun: { runId: homeRunId, conversationId: link.conversation_id, label: 'home' }
    }).run_id
  })
  afterEach(() => {
    home.close()
    server.close()
  })

  function startOnServer(taskId: string, terminal: string): string {
    if (!server.getTask(taskId)) {
      server.createTask({ id: taskId, spec: 'work', runId: peerRunId })
    }
    return createRootDispatch(server, taskId, terminal).id
  }

  /** Sends worker_done on the server, imports everything it queued home, and rereads it here. */
  function deliverWorkerDone(dispatchId: string, payload: { taskId: string; dispatchId: string }) {
    const sent = server.insertMessage({
      from: 'term_worker',
      to: `run:${peerRunId}`,
      subject: 'done',
      body: 'report',
      type: 'worker_done',
      payload: JSON.stringify({ ...payload, outcome: 'succeeded' }),
      runId: peerRunId,
      senderDispatchId: dispatchId
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly these columns.
    const items = server.db
      .prepare(
        `SELECT sequence, message_id AS messageId, kind, payload FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = 'to_home' ORDER BY sequence`
      )
      .all(link.conversation_id) as {
      sequence: number
      messageId: string
      kind: string
      payload: string
    }[]
    for (const item of items) {
      importRemoteOwnedItem(home, remoteServerPin(SERVER), {
        ...item,
        conversationId: link.conversation_id
      })
    }
    return {
      result: reconcileLifecycleMessage(home, home.getMessageById(sent.id)!),
      message: home.getMessageById(sent.id)!
    }
  }

  it('delivers the report of a worker started with --on unchanged', () => {
    const dispatchId = startOnServer(TASK, 'term_worker')
    recordRemoteStart(home, {
      conversationId: link.conversation_id,
      taskId: TASK,
      dispatchId,
      requestKey: KEY,
      peerRunId
    })
    const { result, message } = deliverWorkerDone(dispatchId, { taskId: TASK, dispatchId })
    expect(result).toEqual({ action: 'ignored' })
    expect(message).toMatchObject({ type: 'worker_done', subject: 'done', body: 'report' })
  })

  it("delivers a follow-up's report although its Task exists only on the server", () => {
    startOnServer(TASK, 'term_worker')
    // A send to the finished worker starts its follow-up there under a new Task; this Orca records its Dispatch.
    const followTask = 'task_serveronly01'
    const dispatchId = startOnServer(followTask, 'term_worker_2')
    adoptRemoteAttempt(home, link, { taskId: followTask, dispatchId })
    const { result, message } = deliverWorkerDone(dispatchId, { taskId: followTask, dispatchId })
    expect(home.getTask(followTask)).toBeUndefined()
    expect(result).toEqual({ action: 'ignored' })
    expect(message).toMatchObject({ type: 'worker_done', subject: 'done', body: 'report' })
  })

  it('still rejects a report naming a Dispatch or Task this Orca does not know', () => {
    const dispatchId = startOnServer(TASK, 'term_worker')
    recordRemoteStart(home, {
      conversationId: link.conversation_id,
      taskId: TASK,
      dispatchId,
      requestKey: KEY,
      peerRunId
    })
    expect(
      deliverWorkerDone(dispatchId, { taskId: TASK, dispatchId: 'ctx_nowhere' }).result
    ).toMatchObject({ action: 'rejected', code: 'unknown_dispatch' })
    expect(
      deliverWorkerDone(dispatchId, { taskId: 'task_nowhere', dispatchId }).result
    ).toMatchObject({ action: 'rejected', code: 'unknown_task' })
  })
})
