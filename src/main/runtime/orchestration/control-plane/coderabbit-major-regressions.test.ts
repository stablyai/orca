import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'
import { evaluateCompletionGate } from './completion-gate-enforcement'
import { findSerializationDeadlock } from './outcome-relation-deadlock'

/** Regressions for the CodeRabbit Major findings confirmed against this head.
 *  Each case fails on the behaviour that shipped and passes on the correction.
 */
describe('CODERABBIT_CONFIRMED_MAJORS', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function admittedRun(): { handle: OrchestrationDb; runId: string; taskId: string } {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'deliver it' })
    admitOutcome(store, {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Ship',
      fingerprint: 'f1'
    })
    return { handle: db, runId: task.run_id, taskId: task.id }
  }

  // A failed report is settled as failed. Running the completion gate against it
  // rejected the report instead, so the Dispatch could neither pass nor settle
  // and the failed work was stranded rather than contained.
  describe('a failed report is never blocked by the completion gate', () => {
    it('does not apply the gate to a failed outcome', () => {
      const { handle, runId, taskId } = admittedRun()
      const verdict = evaluateCompletionGate({
        handle,
        runId,
        taskId,
        dispatchId: 'ctx_missing',
        payload: {},
        reportedOutcome: 'failed'
      })
      expect(verdict.applies).toBe(false)
    })

    it('still applies the gate to a succeeded outcome', () => {
      const { handle, runId, taskId } = admittedRun()
      const verdict = evaluateCompletionGate({
        handle,
        runId,
        taskId,
        dispatchId: 'ctx_missing',
        payload: {},
        reportedOutcome: 'succeeded'
      })
      // The gate must still bite for a claimed success — the fix must not turn
      // the gate off for everyone.
      expect(verdict.applies).toBe(true)
      expect(verdict.applies && verdict.ok).toBe(false)
    })
  })

  // A merge chain is built one batch at a time, so the outcomes joining its two
  // ends are usually not in the batch being admitted. A one-hop lookup saw two
  // disjoint groups and let a contradictory serialize through.
  it('detects a serialize that contradicts a merge chain built across batches', () => {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    for (const [left, right] of [
      ['out_a', 'out_c'],
      ['out_c', 'out_d'],
      ['out_d', 'out_b']
    ]) {
      store.insertOutcomeRelation({
        left_outcome_id: left as string,
        right_outcome_id: right as string,
        kind: 'semantic_overlap',
        decision: 'merge',
        rationale: 'same deliverable'
      })
    }

    const deadlock = findSerializationDeadlock(store, {
      batchId: 'later_batch',
      outcomes: [
        { outcomeId: 'out_a', runId: 'run_a', title: 'A', fingerprint: 'fa' },
        { outcomeId: 'out_b', runId: 'run_b', title: 'B', fingerprint: 'fb' }
      ],
      relations: [
        {
          leftOutcomeId: 'out_a',
          rightOutcomeId: 'out_b',
          kind: 'resource_collision',
          decision: 'serialize',
          rationale: 'same file'
        }
      ]
    })

    expect(deadlock?.code).toBe('serialized_with_merged_outcome')
  })

  it('still admits a serialize between genuinely unmerged outcomes', () => {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    expect(
      findSerializationDeadlock(store, {
        batchId: 'b',
        outcomes: [
          { outcomeId: 'out_a', runId: 'run_a', title: 'A', fingerprint: 'fa' },
          { outcomeId: 'out_b', runId: 'run_b', title: 'B', fingerprint: 'fb' }
        ],
        relations: [
          {
            leftOutcomeId: 'out_a',
            rightOutcomeId: 'out_b',
            kind: 'resource_collision',
            decision: 'serialize',
            rationale: 'same file'
          }
        ]
      })
    ).toBeUndefined()
  })
})
