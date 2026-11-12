import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { plansOf } from '../query-plan-capture.test-support'
import { countRemoteDispatches, listRemoteDispatches } from './remote-dispatch-records'
import { closeRemoteRunLink, openRemoteRunLink } from './remote-run-links'

describe('remote-owned queries read through their indexes', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it("closing a link visits only that link's placements and records", () => {
    const run = db.createRun({
      objective: 'Ship',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const link = openRemoteRunLink(db, run.id, {
      environmentId: 'env_b',
      name: 'devB',
      peerFingerprint: 'host_b',
      homePeerFingerprint: 'cred_a',
      pairingRevision: 1
    })

    const plans = plansOf(db, ['remote_placements', 'remote_dispatches'], () =>
      closeRemoteRunLink(db, link.conversation_id, 'The pairing with devB was re-made.')
    )
    expect(plans.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.stringContaining('idx_remote_placements_conversation'),
        expect.stringContaining('idx_remote_dispatches_conversation')
      ])
    )
  })

  it("worker-list for one Run reads that Run's records by its index", () => {
    const plans = plansOf(db, ['remote_dispatches'], () => {
      countRemoteDispatches(db, 'run_1')
      listRemoteDispatches(db, { runId: 'run_1', limit: 50 })
    })
    expect(plans.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
    expect(plans.filter((detail) => detail.includes('idx_remote_dispatches_run'))).toHaveLength(2)
  })
})
