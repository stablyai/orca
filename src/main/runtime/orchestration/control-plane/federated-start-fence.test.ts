import { afterEach, describe, expect, it } from 'vitest'
import {
  assertFederatedWorkerStartAdmitted,
  assertWorkerStartAdmitted
} from '../../rpc/methods/orchestration-worker-route-admission'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcomeIntake } from './outcome-identity'

/** FEDERATED_START_BYPASSES_THE_FENCES — `orchestration.workerStart --on <host>`
 *  returned before `assertWorkerStartAdmitted` ever ran, so it checked the route
 *  and nothing else. A serialized outcome and a worktree under a live validation
 *  lease were both fenced locally and wide open federated.
 *
 *  Where the work executes does not change whether it is allowed to start.
 */
describe('FEDERATED_START_BYPASSES_THE_FENCES', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function serializedPair() {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const runs = [1, 2].map(
      (index) =>
        db!.createRun({
          objective: `Outcome ${index}`,
          coordinatorHandle: `term_${index}`,
          coordinatorPaneKey: `pane_${index}:leaf`
        }).id
    )
    expect(
      admitOutcomeIntake(store, {
        batchId: 'batch_1',
        outcomes: [
          { outcomeId: 'out_1', runId: runs[0], title: 'A', fingerprint: 'f1' },
          { outcomeId: 'out_2', runId: runs[1], title: 'B', fingerprint: 'f2' }
        ],
        detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'resource_collision' }],
        relations: [
          {
            leftOutcomeId: 'out_1',
            rightOutcomeId: 'out_2',
            kind: 'resource_collision',
            decision: 'serialize',
            rationale: 'Both write the same ledger.'
          }
        ]
      }).ok
    ).toBe(true)
    // Outcome 1 is live, so outcome 2 must not start work by any route.
    const task = db.createTask({ spec: 'work', runId: runs[0] })
    db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex' }
    })
    return { runs }
  }

  it('refuses a federated start on an outcome serialized against a live one', () => {
    const { runs } = serializedPair()
    expect(() =>
      assertFederatedWorkerStartAdmitted({ handle: db!, runId: runs[1], agent: 'codex' })
    ).toThrow(/serialized against/)
  })

  it('negative control: the serialization fence releases once the blocker settles', () => {
    const { runs } = serializedPair()
    db!.db.prepare(`UPDATE dispatch_contexts SET status = 'completed'`).run()
    // It now fails on the ROUTE instead, which is the proof that it got past
    // the serialization fence rather than that the fence was never applied.
    expect(() =>
      assertFederatedWorkerStartAdmitted({ handle: db!, runId: runs[1], agent: 'codex' })
    ).toThrow(/is not in the registry/)
  })

  it('fences the local and federated branches identically', () => {
    const { runs } = serializedPair()
    const task = db!.createTask({ spec: 'work', runId: runs[1] })
    for (const start of [
      () =>
        assertWorkerStartAdmitted({ handle: db!, runId: runs[1], taskId: task.id, agent: 'codex' }),
      () => assertFederatedWorkerStartAdmitted({ handle: db!, runId: runs[1], agent: 'codex' })
    ]) {
      expect(start).toThrow(/serialized against/)
    }
  })
})
