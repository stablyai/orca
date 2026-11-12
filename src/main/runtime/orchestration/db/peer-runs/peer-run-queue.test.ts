import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { generateId } from '../generated-id'
import { RemoteOwnedWorkerState } from '../../../../../shared/orchestration/remote-owned-wire'
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
})
