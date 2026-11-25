import { afterEach, describe, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrchestrationWorkerServer } from '../runtime/orchestration/federation/environment-transport'
import { reserveRemotePlacement } from '../runtime/orchestration/db/remote-owned/remote-placements'
import {
  closeRemoteRunLink,
  openRemoteRunLink
} from '../runtime/orchestration/db/remote-owned/remote-run-links'
import { coordinatesLiveRun } from './bot-run-chat-facts'

const CHAT = testOrcaSessionId('5d1e0a6c-2b7f-4c1e-8e1a-3f2b9c0d4e01')
const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'Server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}

let db: OrchestrationDb
afterEach(() => db.close())

describe('a run chat coordinating a Run', () => {
  const coordinatedRun = () =>
    db.createRun({
      objective: 'work',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT
    })

  it('counts a worker still going here, until its Dispatch settles', () => {
    db = new OrchestrationDb(':memory:')
    const run = coordinatedRun()
    expect(coordinatesLiveRun(db, CHAT)).toBe(false)
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(coordinatesLiveRun(db, CHAT)).toBe(true)
    db.completeDispatch(dispatch.id)
    expect(coordinatesLiveRun(db, CHAT)).toBe(false)
  })

  it('counts a Task a paired server holds, which keeps no Dispatch here, while its link is open', () => {
    db = new OrchestrationDb(':memory:')
    const run = coordinatedRun()
    const link = openRemoteRunLink(db, run.id, SERVER)
    reserveRemotePlacement(db, {
      link,
      taskId: 'task_0123456789ab',
      requestKey: 'start-key',
      create: { spec: 'work' }
    })
    expect(coordinatesLiveRun(db, CHAT)).toBe(true)
    closeRemoteRunLink(db, link.conversation_id, 'the pairing was made again')
    expect(coordinatesLiveRun(db, CHAT)).toBe(false)
  })
})
