import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { generateId } from '../generated-id'
import {
  RemoteOwnedWorkerMail,
  RemoteOwnedWorkerState
} from '../../../../../shared/orchestration/remote-owned-wire'
import type { PeerRunRow } from './peer-run-store'

describe("a paired Orca's Run: its queue home", () => {
  let db: OrchestrationDb
  let peerRun: PeerRunRow

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    peerRun = db.admitPeerRun({
      peerFingerprint: 'fingerprint_a',
      peerRun: { runId: 'run_home', conversationId: generateId('peerconv'), label: 'devA' }
    })
  })

  afterEach(() => db.close())

  function start(params: { adoptTaskId?: string; retryOf?: string } = {}) {
    return db.createStartingWorkerDispatch({
      taskSpec: 'Build it',
      taskRunId: peerRun.run_id,
      startOptions: { agent: 'claude' },
      creator: { kind: 'system' },
      maxDepth: 5,
      ...params
    })
  }

  function pending() {
    return db.listPendingFederationRelay(peerRun.conversation_id, 'to_home', 500)
  }

  function states() {
    return pending()
      .filter((item) => item.kind === 'worker_state')
      .map((item) => RemoteOwnedWorkerState.parse(JSON.parse(item.payload)))
  }

  it('never reuses a sequence after a reset, and a reset tells the coordinator what it removed', () => {
    const first = start()
    const throughOld = Math.max(...pending().map((item) => item.sequence))

    db.resetTasks()
    const removed = states().filter((state) => state.removed)
    expect(removed.map((state) => [state.dispatch.id, state.removed?.reason])).toEqual([
      [first.dispatch.id, 'reset on the server running it']
    ])
    start()
    db.acknowledgeFederationRelay({
      dispatchId: peerRun.conversation_id,
      direction: 'to_home',
      throughSequence: throughOld
    })

    const after = pending()
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((item) => item.sequence > throughOld)).toBe(true)
  })

  it("carries home only the Dispatch of this Run's own worker with its mail", () => {
    const own = start()
    const local = db.createRun({
      objective: 'local',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: null
    })
    const foreign = db.createDispatchContext({
      taskId: db.createTask({ runId: local.id, spec: 'Local work' }).id,
      assigneeHandle: 'term_local_worker',
      creator: { kind: 'terminal', handle: 'term_local' },
      maxDepth: 5
    })
    const to = `run:${peerRun.run_id}`
    db.insertMessage({
      id: 'msg_own',
      from: 'term_w',
      to,
      subject: 'mine',
      senderDispatchId: own.dispatch.id,
      runId: peerRun.run_id
    })
    db.insertMessage({
      id: 'msg_foreign',
      from: 'term_local_worker',
      to,
      subject: 'theirs',
      senderDispatchId: foreign.id,
      runId: local.id
    })

    const mail = pending()
      .filter((item) => item.kind === 'worker_mail')
      .map((item) => RemoteOwnedWorkerMail.parse(JSON.parse(item.payload)))
    expect(mail.map((m) => [m.id, m.dispatchId, m.taskId])).toEqual([
      ['msg_own', own.dispatch.id, own.dispatch.task_id],
      ['msg_foreign', null, null]
    ])
  })
})
