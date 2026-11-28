import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { openRemoteRunLink } from './remote-run-links'
import { markRemotePlacementNeverSent } from './remote-placement-hold'
import { getRemotePlacement, reserveRemotePlacement } from './remote-placements'

describe('remote placement send_attempt fencing', () => {
  it('prevents an older unsent failure from marking never_sent_at after a concurrent retry starts', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'o',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: null
      })
      const link = openRemoteRunLink(db, run.id, {
        environmentId: 'env-1',
        name: 'worker-box',
        peerFingerprint: 'peer-fp',
        homePeerFingerprint: 'home-fp',
        pairingRevision: 1
      })
      const first = reserveRemotePlacement(db, {
        link,
        taskId: 'task_race',
        requestKey: 'req-1',
        creator: { kind: 'system' },
        create: { spec: 'do work' }
      })
      const second = reserveRemotePlacement(db, {
        link,
        taskId: 'task_race',
        requestKey: 'req-1',
        creator: { kind: 'system' }
      })
      expect(first.nothingSent).toBe(true)
      expect(second.nothingSent).toBe(false)
      expect(second.sendAttempt).toBe(first.sendAttempt + 1)

      // First attempt fails before sending after the second attempt already started: must not mark never_sent_at.
      markRemotePlacementNeverSent(db, 'task_race', 'req-1', first.sendAttempt)
      expect(getRemotePlacement(db, 'task_race')?.never_sent_at).toBeNull()

      // Cancelling the task must still be refused while the second attempt may have reached the server.
      expect(() => db.updateTaskStatus('task_race', 'failed')).toThrow(/active/)
    } finally {
      db.close()
    }
  })
})
