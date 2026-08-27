import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { ORCHESTRATION_OUTCOME_INTAKE_METHODS } from './orchestration-outcome-intake'

/** BATCH_2_TO_5_INTAKE — atomic multi-outcome intake existed only as a pure
 *  function with no production operation, and its loop admitted outcomes one at
 *  a time, so a batch that failed halfway left the earlier ones bound. This
 *  drives the real RPC method, not the helper underneath it.
 */
describe('BATCH_2_TO_5_INTAKE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const METHOD = ORCHESTRATION_OUTCOME_INTAKE_METHODS.find(
    (method) => method.name === 'orchestration.outcomeIntake'
  )

  // Why async: the handler is synchronous, so a thrown OrchestrationError would
  // not be a rejected promise for `.rejects` without this boundary.
  async function call(input: unknown) {
    db ??= new OrchestrationDb(':memory:')
    const params = METHOD!.params!.parse(input)
    return METHOD!.handler(params, {
      runtime: { getOrchestrationDb: () => db }
    } as never)
  }

  function outcome(index: number) {
    return {
      outcomeId: `out_${index}`,
      runId: `run_${index}`,
      title: `Outcome ${index}`,
      fingerprint: `f_${index}`
    }
  }

  it('is a real registered RPC operation', () => {
    expect(METHOD).toBeDefined()
  })

  it('binds a 2-5 batch of independent outcomes atomically and returns one receipt', async () => {
    const receipt = (await call({
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2), outcome(3)]
    })) as { batchId: string; count: number; admitted: { outcomeId: string; runId: string }[] }
    expect(receipt.batchId).toBe('batch_1')
    expect(receipt.count).toBe(3)
    expect(receipt.admitted.map((entry) => entry.runId)).toEqual(['run_1', 'run_2', 'run_3'])
    // Each outcome kept its own distinct Run identity.
    expect(new Set(receipt.admitted.map((entry) => entry.runId)).size).toBe(3)
  })

  it('never partially admits: a batch that fails admits none of it', async () => {
    // out_1 is bound to run_1 first, so the second batch collides on it.
    await call({ batchId: 'batch_1', outcomes: [outcome(1), outcome(2)] })
    const before = new ControlPlaneStore(db!).getOutcomeById('out_9')
    expect(before).toBeUndefined()
    await expect(
      call({
        batchId: 'batch_2',
        outcomes: [outcome(9), { ...outcome(1), runId: 'run_conflict' }]
      })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    // out_9 came FIRST in the failing batch and must not survive it.
    expect(new ControlPlaneStore(db!).getOutcomeById('out_9')).toBeUndefined()
  })

  it('is replay-idempotent for an identical batch', async () => {
    const first = (await call({
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2)]
    })) as { count: number }
    const replay = (await call({
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2)]
    })) as { count: number }
    expect(replay.count).toBe(first.count)
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 2
    })
  })

  it('refuses a detected overlap that carries no decision, before any builder launches', async () => {
    await expect(
      call({
        batchId: 'batch_1',
        outcomes: [outcome(1), outcome(2)],
        detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'semantic_overlap' }]
      })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 0
    })
  })

  it('serializes a dangerous overlap the supplier decided, and records the decision', async () => {
    const receipt = (await call({
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2)],
      detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'resource_collision' }],
      relations: [
        {
          leftOutcomeId: 'out_1',
          rightOutcomeId: 'out_2',
          kind: 'resource_collision',
          decision: 'serialize',
          rationale: 'Both touch the same worktree.'
        }
      ]
    })) as { count: number; relations: { decision: string }[] }
    expect(receipt.count).toBe(2)
    expect(receipt.relations[0].decision).toBe('serialize')
    expect(new ControlPlaneStore(db!).listOutcomeRelations('out_1')).toHaveLength(1)
  })

  it('refuses the whole batch when the supplier decided reject', async () => {
    await expect(
      call({
        batchId: 'batch_1',
        outcomes: [outcome(1), outcome(2)],
        relations: [
          {
            leftOutcomeId: 'out_1',
            rightOutcomeId: 'out_2',
            kind: 'semantic_overlap',
            decision: 'reject',
            rationale: 'These are the same issue.'
          }
        ]
      })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcomes').get()).toEqual({
      n: 0
    })
  })

  it('rejects a batch outside the 2-5 band', async () => {
    await expect(call({ batchId: 'b', outcomes: [outcome(1)] })).rejects.toMatchObject({
      code: 'outcome_intake_rejected'
    })
    await expect(
      call({
        batchId: 'b',
        outcomes: [1, 2, 3, 4, 5, 6].map((index) => outcome(index))
      })
    ).rejects.toMatchObject({ code: 'outcome_intake_rejected' })
  })
})
