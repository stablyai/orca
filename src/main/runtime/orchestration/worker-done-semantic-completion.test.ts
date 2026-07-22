import { describe, expect, it } from 'vitest'
import {
  evaluateWorkerDoneSemanticCompletion,
  taskSpecDefinesCodeCompleteActivationSplit
} from './worker-done-semantic-completion'

describe('evaluateWorkerDoneSemanticCompletion', () => {
  it('accepts an ordinary successful worker_done', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'ORCH-R10 complete',
        body: 'Implemented the guard, verified tests, and opened the PR.',
        filesModified: ['src/main/runtime/orchestration/lifecycle-reconciliation.ts']
      })
    ).toEqual({ complete: true })
  })

  it('rejects the exact INC-3 incomplete shape as failed', () => {
    // Observed 2026-07-22: task_c51afc88a23d / ctx_750a6815bc9f completed on an
    // empty-files worker_done while migration 0129 failed transactionally and
    // remaining reconciliation/activation gates were still reported.
    const verdict = evaluateWorkerDoneSemanticCompletion({
      subject: 'INC-3 migration remaining',
      body:
        'Attempted activation for INC-3. Migration 0129 failed transactionally. ' +
        'Remaining reconciliation/activation gates still block deploy and E2E. ' +
        'No migration/deploy/E2E has occurred.',
      filesModified: [],
      taskSpec: 'Activate incident producer after owner-gated migration approval.'
    })
    expect(verdict).toMatchObject({
      complete: false,
      kind: 'failure',
      appliedStatus: 'failed'
    })
  })

  it('rejects Failed: subjects without completing', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Failed: review gate red',
        body: 'Could not finish the required checks.'
      })
    ).toMatchObject({ complete: false, kind: 'failure', appliedStatus: 'failed' })
  })

  it('rejects blocked and decision-required worker_done', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Blocked: waiting on queue binding',
        body: 'PR remains open and blocked on the activation dependency.'
      })
    ).toMatchObject({ complete: false, kind: 'blocked', appliedStatus: 'blocked' })

    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Need direction',
        body: 'Decision-required: choose whether to keep the binding or re-scope.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'decision_required',
      appliedStatus: 'blocked'
    })
  })

  it('rejects unresolved escalation and remaining gates without an explicit split', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Done for now',
        body: 'There is still an unresolved escalation on the coordinator inbox.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'unresolved_escalation',
      appliedStatus: 'blocked'
    })

    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Code pushed',
        body: 'What\'s left: remaining activation gates before deploy.',
        taskSpec: 'Ship the docs-only change and open a PR.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })
  })

  it('preserves an explicit durable code-complete/activation-gate split', () => {
    const spec =
      'Send worker_done when the code/docs change is complete. ' +
      'The durable task defines a code-complete vs activation split; ' +
      'owner-gated activation may remain unmet.'
    expect(taskSpecDefinesCodeCompleteActivationSplit(spec)).toBe(true)
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Code complete; activation pending',
        body: 'Diff is review-clean. Remaining activation gates are owner-gated.',
        filesModified: ['ORCHESTRATION.md'],
        taskSpec: spec
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })
  })

  it('fails closed for pending activation wording without a durable split', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Activation pending',
        body: 'Waiting for owner approval before the migration can run.',
        filesModified: [],
        taskSpec: 'Activate after migration.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })
  })

  it('still requires completion evidence when an activation split is present', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Activation pending',
        body: 'Waiting for owner approval before the migration can run.',
        filesModified: [],
        taskSpec:
          'Send worker_done when the code/docs change is complete. ' +
          'The durable task defines a code-complete vs activation split.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })
  })

  it('does not reclassify narratively resolved past failures as current failures', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'ORCH-R10 complete',
        body:
          'Migration failed on the first attempt, then succeeded after retry. ' +
          'The blocked deployment was resolved. Implementation is complete.',
        filesModified: ['src/main/runtime/orchestration/lifecycle-reconciliation.ts']
      })
    ).toEqual({ complete: true })
  })

  it('requires an explicit completion claim; filesModified alone is not enough', () => {
    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Migration update',
        body: 'I updated the migration, but still need to update the application.',
        filesModified: ['drizzle/0129_something.sql'],
        taskSpec: 'Ship the migration and application follow-up.'
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })

    expect(
      evaluateWorkerDoneSemanticCompletion({
        subject: 'Touched files',
        body: 'Edited the helper without claiming completion.',
        filesModified: ['src/main/runtime/orchestration/worker-done-semantic-completion.ts']
      })
    ).toMatchObject({
      complete: false,
      kind: 'remaining_gates',
      appliedStatus: 'blocked'
    })
  })
})
