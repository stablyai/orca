import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcomeIntake } from './outcome-intake'
import { assertOutcomeSerializationAllowed } from './outcome-serialization'

/** SERIALIZED_OVERLAP_MUST_NOT_LAUNCH — intake recorded `serialize` decisions
 *  and nothing ever read them, so two outcomes an operator explicitly said must
 *  not run together could both start workers.
 */
describe('SERIALIZED_OVERLAP_MUST_NOT_LAUNCH', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const WORKTREE = 'repo_a::/work/serialized'

  /** Intake now refuses an outcome that declares no required gates and no
   *  routing policy. This fixture is about serialization decisions, so it
   *  supplies the minimum that makes an outcome admittable at all. */
  function admittable(outcomeId: string, runId: string, title: string, fingerprint: string) {
    return {
      outcomeId,
      runId,
      title,
      fingerprint,
      // Intake binds an outcome to the workspace it may be implemented in, and
      // the start path refuses a Dispatch resolved anywhere else.
      target: `id:${WORKTREE}`,
      routingPolicy: {
        taskClassification: 'bounded_implementation' as const,
        builderCandidates: [{ agent: 'claude' as const, model: 'opus-5', reasoning: 'high' }],
        reviewerCandidates: [{ agent: 'claude' as const, model: 'fable', reasoning: 'high' }],
        reviewCapabilities: ['adversarial_review' as const],
        allowUnknownQuota: false
      },
      requiredGates: [
        {
          gateId: 'unit',
          program: 'pnpm',
          args: ['test'],
          dependencies: ['git:src'],
          policyVersion: 'unit-v1',
          commandIdentity: 'pnpm:test:v1',
          shaBinding: 'exact_head' as const
        }
      ]
    }
  }

  function world(decision: 'serialize' | 'independent') {
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
    const admitted = admitOutcomeIntake(store, {
      batchId: 'batch_1',
      outcomes: [admittable('out_1', runs[0], 'A', 'f1'), admittable('out_2', runs[1], 'B', 'f2')],
      detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'resource_collision' }],
      relations: [
        {
          leftOutcomeId: 'out_1',
          rightOutcomeId: 'out_2',
          kind: 'resource_collision',
          decision,
          rationale: 'Both write the same ledger.'
        }
      ]
    })
    expect(admitted.ok).toBe(true)
    return { store, runs }
  }

  /** Gives outcome 1's Run a live Dispatch. */
  function startWorkOn(runId: string) {
    const task = db!.createTask({ spec: 'work', runId })
    const started = db!.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex', resolvedWorktreeId: WORKTREE }
    })
    return started.dispatch.id
  }

  it('refuses to start the second outcome while the first is live', () => {
    const { store, runs } = world('serialize')
    const blocking = startWorkOn(runs[0])
    const verdict = assertOutcomeSerializationAllowed({ db: db!, store, runId: runs[1] })
    expect(verdict.allowed).toBe(false)
    expect(verdict).toMatchObject({
      code: 'serialized_with_active_outcome',
      blockingOutcomeId: 'out_1',
      blockingRunId: runs[0],
      blockingDispatchId: blocking
    })
  })

  it('allows the second outcome once the first has settled', () => {
    const { store, runs } = world('serialize')
    const blocking = startWorkOn(runs[0])
    expect(assertOutcomeSerializationAllowed({ db: db!, store, runId: runs[1] }).allowed).toBe(
      false
    )
    db!.db.prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`).run(blocking)
    expect(assertOutcomeSerializationAllowed({ db: db!, store, runId: runs[1] }).allowed).toBe(true)
  })

  it('lets independent outcomes run concurrently', () => {
    const { store, runs } = world('independent')
    startWorkOn(runs[0])
    expect(assertOutcomeSerializationAllowed({ db: db!, store, runId: runs[1] }).allowed).toBe(true)
  })

  it('is inert for a Run with no admitted outcome', () => {
    const { store } = world('serialize')
    expect(
      assertOutcomeSerializationAllowed({ db: db!, store, runId: 'run_unbound' }).allowed
    ).toBe(true)
  })
})
