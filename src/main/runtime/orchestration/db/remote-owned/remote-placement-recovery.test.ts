import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { getRemotePlacement, reserveRemotePlacement } from './remote-placements'
import { markRemotePlacementAmbiguous, markRemotePlacementSent } from './remote-placement-hold'
import { openRemoteRunLink } from './remote-run-links'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'Server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const TASK = 'task_0123456789ab'

describe('ambiguous remote start recovery', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const link = openRemoteRunLink(db, run.id, SERVER)
    reserveRemotePlacement(db, {
      link,
      taskId: TASK,
      requestKey: 'start-key',
      create: { spec: 'work' }
    })
  })

  afterEach(() => db.close())

  it('lets an operator cancel an old unanswered start left by an earlier version', () => {
    db.db
      .prepare(
        "UPDATE remote_placements SET created_at = datetime('now', '-16 minutes') WHERE task_id = ?"
      )
      .run(TASK)

    expect(db.updateTaskStatus(TASK, 'failed')?.status).toBe('failed')
    expect(getRemotePlacement(db, TASK)).toBeUndefined()
  })

  it('waits from an unanswered send, not from the reservation it retried', () => {
    db.db
      .prepare(
        "UPDATE remote_placements SET created_at = datetime('now', '-16 minutes') WHERE task_id = ?"
      )
      .run(TASK)
    markRemotePlacementAmbiguous(db, TASK, 'start-key')

    expect(() => db.updateTaskStatus(TASK, 'failed')).toThrow(/cannot move to failed/)
    expect(getRemotePlacement(db, TASK)?.ambiguous_sent_at).not.toBeNull()
  })

  it('keeps an in-flight send fenced even when its legacy reservation is old', () => {
    db.db
      .prepare(
        "UPDATE remote_placements SET created_at = datetime('now', '-16 minutes') WHERE task_id = ?"
      )
      .run(TASK)
    markRemotePlacementSent(db, TASK, 'start-key')

    expect(() => db.updateTaskStatus(TASK, 'failed')).toThrow(/cannot move to failed/)
    expect(getRemotePlacement(db, TASK)?.sent_at).not.toBeNull()
  })

  it('keeps a recent unanswered start fenced for same-request recovery', () => {
    expect(() => db.updateTaskStatus(TASK, 'failed')).toThrow(/cannot move to failed/)
    expect(getRemotePlacement(db, TASK)).toMatchObject({ state: 'reserved' })
    expect(db.getTask(TASK)?.status).toBe('dispatched')
  })

  it('lets an operator cancel an old unanswered retry that still names its previous Dispatch', () => {
    db.db
      .prepare(
        "UPDATE remote_placements SET dispatch_id = 'dispatch_old', created_at = datetime('now', '-16 minutes') WHERE task_id = ?"
      )
      .run(TASK)

    expect(db.updateTaskStatus(TASK, 'failed')?.status).toBe('failed')
    expect(getRemotePlacement(db, TASK)).toBeUndefined()
  })
})
