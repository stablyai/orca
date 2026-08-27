import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  admitOutcome,
  admitOutcomeIntake,
  outcomeFingerprint,
  requireOutcomeMatch,
  resolveOutcomeBinding
} from './outcome-identity'

describe('B2 one outcome, one durable Run', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  it('binds an outcome to exactly one Run', () => {
    const cp = store()
    const admission = admitOutcome(cp, {
      outcomeId: 'out_1',
      runId: 'run_1',
      title: 'Ship the invoice export',
      fingerprint: outcomeFingerprint(['ship', 'invoice', 'export'])
    })
    expect(admission).toMatchObject({ ok: true, duplicate: false })
    expect(resolveOutcomeBinding(cp, 'run_1')).toMatchObject({ kind: 'admitted' })
  })

  it('rejects a new outcome silently inheriting an unrelated historical Run', () => {
    const cp = store()
    admitOutcome(cp, {
      outcomeId: 'out_old',
      runId: 'run_shared',
      title: 'Old work',
      fingerprint: 'f_old'
    })
    expect(
      admitOutcome(cp, {
        outcomeId: 'out_new',
        runId: 'run_shared',
        title: 'Unrelated new issue',
        fingerprint: 'f_new'
      })
    ).toMatchObject({ ok: false, error: { code: 'run_bound_to_other_outcome' } })
  })

  it('rejects rebinding one outcome onto a second Run', () => {
    const cp = store()
    admitOutcome(cp, { outcomeId: 'out_1', runId: 'run_a', title: 'A', fingerprint: 'f' })
    expect(
      admitOutcome(cp, { outcomeId: 'out_1', runId: 'run_b', title: 'A', fingerprint: 'f' })
    ).toMatchObject({ ok: false, error: { code: 'outcome_bound_to_other_run' } })
  })

  it('is idempotent for an identical replayed admission and rejects a changed fingerprint', () => {
    const cp = store()
    const request = { outcomeId: 'out_1', runId: 'run_1', title: 'A', fingerprint: 'f' }
    expect(admitOutcome(cp, request)).toMatchObject({ ok: true, duplicate: false })
    expect(admitOutcome(cp, request)).toMatchObject({ ok: true, duplicate: true })
    expect(admitOutcome(cp, { ...request, fingerprint: 'f2' })).toMatchObject({
      ok: false,
      error: { code: 'fingerprint_conflict' }
    })
  })

  it('fails closed when a new write claims an outcome on an unbound legacy Run', () => {
    const cp = store()
    expect(resolveOutcomeBinding(cp, 'run_legacy')).toEqual({ kind: 'legacy_unbound' })
    expect(requireOutcomeMatch(cp, { runId: 'run_legacy', outcomeId: 'out_x' })).toMatchObject({
      ok: false,
      error: { code: 'run_bound_to_other_outcome' }
    })
  })

  it('rejects a write that claims the wrong outcome for an admitted Run', () => {
    const cp = store()
    admitOutcome(cp, { outcomeId: 'out_1', runId: 'run_1', title: 'A', fingerprint: 'f' })
    expect(requireOutcomeMatch(cp, { runId: 'run_1', outcomeId: 'out_2' })).toMatchObject({
      ok: false,
      error: { code: 'run_bound_to_other_outcome' }
    })
    expect(requireOutcomeMatch(cp, { runId: 'run_1', outcomeId: 'out_1' })).toMatchObject({ ok: true })
  })
})

describe('B2 intake of 2-5 independent outcomes', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  function outcome(index: number) {
    return {
      outcomeId: `out_${index}`,
      runId: `run_${index}`,
      title: `Outcome ${index}`,
      fingerprint: `f_${index}`
    }
  }

  it('admits five independent outcomes, each to its own Run', () => {
    const cp = store()
    const result = admitOutcomeIntake(cp, {
      batchId: 'batch_1',
      outcomes: [outcome(1), outcome(2), outcome(3), outcome(4), outcome(5)]
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.admitted.map((row) => row.run_id)).toEqual([
      'run_1',
      'run_2',
      'run_3',
      'run_4',
      'run_5'
    ])
    // Each stays independently addressable afterwards.
    expect(cp.getOutcomeByRun('run_3')?.outcome_id).toBe('out_3')
  })

  it('rejects an intake outside the 2-5 band', () => {
    const cp = store()
    expect(admitOutcomeIntake(cp, { batchId: 'b', outcomes: [outcome(1)] })).toMatchObject({
      ok: false,
      error: { code: 'intake_size_invalid' }
    })
    expect(
      admitOutcomeIntake(cp, {
        batchId: 'b',
        outcomes: [outcome(1), outcome(2), outcome(3), outcome(4), outcome(5), outcome(6)]
      })
    ).toMatchObject({ ok: false, error: { code: 'intake_size_invalid' } })
  })

  it('refuses a detected overlap or collision with no explicit decision', () => {
    const cp = store()
    expect(
      admitOutcomeIntake(cp, {
        batchId: 'b',
        outcomes: [outcome(1), outcome(2)],
        detected: [{ leftOutcomeId: 'out_1', rightOutcomeId: 'out_2', kind: 'semantic_overlap' }]
      })
    ).toMatchObject({ ok: false, error: { code: 'undecided_relation' } })
  })

  it('admits the same pair once the overlap decision is explicit and records it', () => {
    const cp = store()
    const result = admitOutcomeIntake(cp, {
      batchId: 'b',
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
    })
    expect(result.ok).toBe(true)
    expect(cp.listOutcomeRelations('out_1')).toEqual([
      expect.objectContaining({ kind: 'resource_collision', decision: 'serialize' })
    ])
  })

  it('rejects a duplicate outcome id inside one intake batch', () => {
    const cp = store()
    expect(
      admitOutcomeIntake(cp, { batchId: 'b', outcomes: [outcome(1), outcome(1)] })
    ).toMatchObject({ ok: false, error: { code: 'duplicate_outcome_id' } })
  })
})

describe('B2 historical compatibility', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('leaves pre-existing Runs, Tasks and Dispatches readable and unchanged', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'historical work' })
    const before = db.getTask(task.id)
    // Opening the control plane creates its tables but must not touch legacy rows.
    const cp = new ControlPlaneStore(db)
    expect(db.getTask(task.id)).toEqual(before)
    expect(cp.getOutcomeByRun(task.run_id)).toBeUndefined()
    expect(resolveOutcomeBinding(cp, task.run_id)).toEqual({ kind: 'legacy_unbound' })
  })
})
