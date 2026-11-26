import { afterEach, describe, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  fixtureSession,
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

const stores: PipelineStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))

function create() {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  return store
}

describe('durable configurable stage transitions', () => {
  it('waits on the settled candidate without following its configured target', () => {
    const store = create()
    const run = settleV2Stage(store)
    expect(run).toMatchObject({
      state: 'waiting_owner',
      stageId: 'plan',
      pendingDecision: {
        visitId: 'run-1:visit:1',
        sourceRevision: fixtureSource,
        proposedOutcomeId: 'done',
        proposedTarget: { kind: 'stage', stageId: 'implement' }
      }
    })
    expect(run.visits.map((visit) => visit.id)).toEqual(['run-1:visit:1'])
  })

  it('does not treat resume as acceptance of a result', () => {
    const store = create()
    settleV2Stage(store)
    expect(() => v2Mutation(store, { kind: 'resume' })).toThrow('pipeline_owner_decision_required')
    expect(store.getV2('run-1').stageId).toBe('plan')
  })

  it('accepts exactly the pinned pending candidate and creates a separate next visit', () => {
    const store = create()
    const waiting = settleV2Stage(store)
    const accepted = v2Mutation(store, {
      kind: 'decide',
      action: 'accept',
      ...waiting.pendingDecision!
    })
    expect(accepted).toMatchObject({ state: 'running', stageId: 'implement' })
    expect(accepted.visits.map((visit) => [visit.id, visit.stageId])).toEqual([
      ['run-1:visit:1', 'plan'],
      ['run-1:visit:2', 'implement']
    ])
    expect(accepted.pendingDecision).toBeUndefined()
  })

  it('records a rework comment and returns to the stage selected by the gate', () => {
    const store = create()
    const waiting = settleV2Stage(store)
    const rework = v2Mutation(store, {
      kind: 'decide',
      action: 'rework',
      comment: 'Add rounding cases to the plan.',
      ...waiting.pendingDecision!
    })
    expect(rework).toMatchObject({ state: 'running', stageId: 'plan' })
    expect(rework.visits.at(-1)).toMatchObject({
      id: 'run-1:visit:2',
      attempt: 1,
      handoff: { comment: 'Add rounding cases to the plan.' }
    })
  })

  it('rejects a changed candidate digest instead of applying the owner decision', () => {
    const store = create()
    const waiting = settleV2Stage(store)
    expect(() =>
      v2Mutation(store, {
        kind: 'decide',
        action: 'accept',
        ...waiting.pendingDecision!,
        candidateDigest: 'f'.repeat(64)
      })
    ).toThrow('pipeline_candidate_conflict')
    expect(store.getV2('run-1').state).toBe('waiting_owner')
  })

  it('lets an active step settle during pause without dispatching its successor', () => {
    const store = create()
    v2Mutation(store, {
      kind: 'reserve',
      invocationId: 'active',
      purpose: 'stage',
      sourceRevision: fixtureSource
    })
    const inputRevision = store.getV2('run-1').invocations[0].inputRevision
    v2Mutation(store, {
      kind: 'bind',
      invocationId: 'active',
      dispatchId: 'active',
      session: fixtureSession
    })
    v2Mutation(store, { kind: 'pause' })
    v2Mutation(store, {
      kind: 'submit',
      invocationId: 'active',
      dispatchId: 'active',
      inputRevision,
      sourceRevision: fixtureSource,
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 'Plan complete',
        evidence: {
          stage: 'generic',
          statement: 'Plan ready',
          rationale: 'Requirements covered',
          files: []
        }
      }
    })
    const paused = v2Mutation(store, { kind: 'settle', invocationId: 'active' })
    expect(paused).toMatchObject({ state: 'paused', stageId: 'plan' })
    expect(paused.pendingDecision?.proposedTarget).toEqual({ kind: 'stage', stageId: 'implement' })
    expect(paused.invocations.map((invocation) => invocation.id)).toEqual(['active'])
  })

  it('preserves the result when its version is disabled during execution', () => {
    const store = create()
    v2Mutation(store, { kind: 'definition_disabled' })
    expect(() =>
      v2Mutation(store, {
        kind: 'reserve',
        invocationId: 'not-started',
        purpose: 'stage',
        sourceRevision: fixtureSource
      })
    ).toThrow('pipeline_definition_disabled')
    expect(store.getV2('run-1').invocations).toEqual([])
    v2Mutation(store, { kind: 'definition_enabled' })
    v2Mutation(store, { kind: 'resume' })
    v2Mutation(store, {
      kind: 'reserve',
      invocationId: 'active',
      purpose: 'stage',
      sourceRevision: fixtureSource
    })
    const inputRevision = store.getV2('run-1').invocations[0].inputRevision
    v2Mutation(store, {
      kind: 'bind',
      invocationId: 'active',
      dispatchId: 'active',
      session: fixtureSession
    })
    v2Mutation(store, { kind: 'definition_disabled' })
    v2Mutation(store, {
      kind: 'submit',
      invocationId: 'active',
      dispatchId: 'active',
      inputRevision,
      sourceRevision: fixtureSource,
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 'Result retained',
        evidence: {
          stage: 'generic',
          statement: 'Plan ready',
          rationale: 'Requirements covered',
          files: []
        }
      }
    })
    const disabled = v2Mutation(store, { kind: 'settle', invocationId: 'active' })
    expect(disabled.state).toBe('paused')
    expect(disabled.candidates[0].summary).toBe('Result retained')
    expect(() => v2Mutation(store, { kind: 'resume' })).toThrow('pipeline_definition_disabled')
  })

  it('rejects stale revisions, changed replay bodies and replaced workspace instances', () => {
    const store = create()
    const mutation = {
      requestId: 'pause-once',
      expectedRevision: 0,
      expectedInstanceId: 'instance-1',
      command: { kind: 'pause' }
    }
    store.commandV2('run-1', mutation)
    expect(store.commandV2('run-1', mutation).revision).toBe(1)
    expect(() => store.commandV2('run-1', { ...mutation, command: { kind: 'resume' } })).toThrow(
      'pipeline_request_conflict'
    )
    expect(() => store.commandV2('run-1', { ...mutation, requestId: 'new-request' })).toThrow(
      'pipeline_revision_conflict'
    )
    expect(() =>
      store.commandV2('run-1', {
        ...mutation,
        requestId: 'replacement',
        expectedRevision: 1,
        expectedInstanceId: 'instance-2'
      })
    ).toThrow('pipeline_workspace_instance_changed')
    expect(store.receiptV2('run-1', 'pause-once')).toMatchObject({
      runId: 'run-1',
      requestId: 'pause-once',
      inputRevision: 0,
      acceptedRevision: 1,
      kind: 'pause'
    })
  })

  it('does not record a budget extension that actually lowers the discussion limit', () => {
    const store = create()
    settleV2Stage(store)
    expect(() =>
      v2Mutation(store, { kind: 'extend_budget', visitId: 'run-1:visit:1', maxDiscussionTurns: 1 })
    ).toThrow('pipeline_budget_conflict')
    expect(store.getV2('run-1').budgetExtensions).toEqual([])
  })
})
