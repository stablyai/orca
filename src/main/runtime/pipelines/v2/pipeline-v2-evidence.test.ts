import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  pipelineV2AgentStage,
  pipelineV2ReviewedFixture
} from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  fixtureSource,
  fixtureSession,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'
import type { PipelineV2Candidate } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { evaluatePipelineV2Completion } from './pipeline-v2-completion'
import { advancePipelineV2 } from './pipeline-v2-execution'
import { PipelineController } from '../pipeline-controller'
import { discussPipelineV2 } from './pipeline-v2-discussion'
import { pipelineV2FindingLedger } from './pipeline-v2-finding-ledger'

let store: PipelineStore
beforeEach(() => {
  store = new PipelineStore(':memory:')
})
afterEach(() => store.close())
function createReviewed(
  gatedReview = false,
  findingDisputes?: 'owner_acknowledgment' | 'stage_rationale'
) {
  const template = pipelineV2ReviewedFixture()
  if (findingDisputes && template.completionPolicy.kind === 'reviewed_source') {
    template.completionPolicy.findingPolicy = 'tracked'
    template.completionPolicy.findingDisputes = findingDisputes
  }
  template.stages[3].ownerGate.enabled = gatedReview
  template.stages[3].outcomes[0].target = { kind: 'next' }
  const docs = pipelineV2AgentStage('docs')
  if (docs.kind !== 'agent') {
    throw new Error('Expected agent')
  }
  docs.evidenceSchema = 'docs'
  docs.outcomes = [
    { id: 'done', title: 'Done', criterion: 'Documentation assessed', target: { kind: 'finish' } },
    {
      id: 'again',
      title: 'Repeat',
      criterion: 'Another assessment needed',
      target: { kind: 'stage', stageId: 'checks' }
    }
  ]
  template.stages.push(docs)
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  settleV2Stage(store)
}
function stage(
  outcomeId: string,
  evidence: Extract<PipelineV2Candidate['result'], { status: 'result' }>['evidence'],
  source = fixtureSource,
  pauseBeforeSubmit = false,
  sessionId?: string,
  findingUpdates?: PipelineV2Candidate['result']['findingUpdates']
) {
  const run = store.getV2('run-1')
  const invocationId = `quality-${run.usedInvocations + 1}`
  v2Mutation(store, {
    kind: 'reserve',
    invocationId,
    purpose: 'stage',
    sourceRevision: source,
    ...(run.stageId === 'review' ? { reviewCommit: 'b'.repeat(40) } : {})
  })
  const invocation = store.getV2('run-1').invocations.at(-1)!
  v2Mutation(store, {
    kind: 'bind',
    invocationId,
    dispatchId: invocationId,
    session: {
      kind: run.stageId === 'checks' ? 'checks' : 'structured',
      sessionId: sessionId ?? invocationId,
      compatibilityKey: run.stageId === 'checks' ? run.definitionDigest : 'c'.repeat(64)
    }
  })
  if (pauseBeforeSubmit) {
    v2Mutation(store, { kind: 'pause' })
  }
  v2Mutation(store, {
    kind: 'submit',
    invocationId,
    dispatchId: invocationId,
    inputRevision: invocation.inputRevision,
    sourceRevision: source,
    result: {
      status: 'result',
      outcomeId,
      summary: `${run.stageId} result`,
      evidence,
      ...(findingUpdates ? { findingUpdates } : {})
    }
  })
  return v2Mutation(store, { kind: 'settle', invocationId })
}
function checks(source = fixtureSource) {
  stage(
    'green',
    {
      stage: 'checks',
      results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }]
    },
    source
  )
}
it('readiness follows explicit self-review requirements while retaining current source fences', () => {
  const template = pipelineV2ReviewedFixture()
  const review = template.stages[3]
  if (review.kind !== 'agent' || template.completionPolicy.kind !== 'reviewed_source') {
    throw new Error('Expected reviewed fixture')
  }
  review.independent = false
  review.executor.session = { kind: 'reuse', groupId: 'primary' }
  template.completionPolicy.reviewRequirements[0] = {
    stageId: 'review',
    acceptedOutcomeIds: ['approved'],
    independent: false,
    freshSession: false
  }
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  settleV2Stage(store)
  checks()
  stage(
    'approved',
    { stage: 'review', findings: [] },
    fixtureSource,
    false,
    fixtureSession.sessionId
  )
  const run = store.getV2('run-1')
  expect(evaluatePipelineV2Completion(run, fixtureSource).ready).toBe(true)
  expect(evaluatePipelineV2Completion(run, 'e'.repeat(64)).ready).toBe(false)
  const requirement = run.definition.completionPolicy
  if (requirement.kind === 'reviewed_source') {
    requirement.reviewRequirements[0].independent = true
  }
  expect(evaluatePipelineV2Completion(run, fixtureSource).ready).toBe(false)
})
it('old_review_pass_cannot_hide_new_failure_or_unfinished_visit', () => {
  createReviewed()
  checks()
  stage('approved', { stage: 'review', findings: [] })
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(true)
  stage('again', { stage: 'docs', files: [], rationale: 'No documentation changes needed' })
  checks()
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(false)
  stage('changes', {
    stage: 'review',
    findings: [
      { severity: 'important', detail: 'Missing edge case', conditionToFix: 'Cover the edge case' }
    ]
  })
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(false)
})
it('keeps important findings across returns and verifies fixes only after checks and a later accepted review', () => {
  createReviewed()
  checks()
  stage('changes', {
    stage: 'review',
    findings: [
      {
        severity: 'important',
        detail: 'Expired lease accepted',
        conditionToFix: 'Fence expired lease'
      }
    ]
  })
  const id = 'finding:a8f6a1b7c3198b94584172c7b81e07ac0c892e506d3774ac46fa15d00d38cee2'
  expect(pipelineV2FindingLedger(store.getV2('run-1'), fixtureSource, false)).toMatchObject({
    total: 1,
    unresolvedImportant: 1,
    findings: [{ id, disposition: 'open' }]
  })
  settleV2Stage(store)
  stage(
    'done',
    { stage: 'generic', statement: 'Fixed', rationale: 'Expired lease is fenced', files: [] },
    fixtureSource,
    false,
    undefined,
    [{ id, disposition: 'fixed', rationale: 'Added lease expiry fence' }]
  )
  expect(pipelineV2FindingLedger(store.getV2('run-1'), fixtureSource, false)).toMatchObject({
    unresolvedImportant: 1,
    findings: [{ id, disposition: 'open', proposedFixed: true }]
  })
  checks()
  stage('approved', { stage: 'review', findings: [] })
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(true)
  expect(pipelineV2FindingLedger(store.getV2('run-1'), fixtureSource, true)).toMatchObject({
    unresolvedImportant: 0,
    findings: [{ id, disposition: 'fixed_verified', proposedFixed: false }]
  })
  expect(pipelineV2FindingLedger(store.getV2('run-1'), 'e'.repeat(64), false)).toMatchObject({
    unresolvedImportant: 1,
    findings: [{ id, disposition: 'open', proposedFixed: true }]
  })
})
it('generic_evidence_is_not_independent_review', () => {
  createReviewed()
  checks()
  expect(() =>
    stage('approved', {
      stage: 'generic',
      statement: 'Looks good',
      rationale: 'No defects noticed',
      files: []
    })
  ).toThrow('pipeline_stage_evidence_mismatch')
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(false)
})

it.each([
  ['owner_acknowledgment', false, false],
  ['owner_acknowledgment', true, true],
  ['stage_rationale', false, true]
] as const)(
  'resolves requirement disputes under %s with owner gate %s according to the selected policy',
  (policy, gated, ready) => {
    createReviewed(gated, policy)
    checks()
    const finding = {
      severity: 'important' as const,
      detail: 'Rename public API',
      conditionToFix: 'Replace the existing API'
    }
    stage('changes', { stage: 'review', findings: [finding] })
    const accept = () => {
      const pending = store.getV2('run-1').pendingDecision
      if (pending) {
        v2Mutation(store, { kind: 'decide', ...pending, action: 'accept' })
      }
    }
    accept()
    const id = pipelineV2FindingLedger(store.getV2('run-1'), fixtureSource, false).findings[0].id
    settleV2Stage(store)
    settleV2Stage(store)
    checks()
    stage(
      'approved',
      { stage: 'review', findings: [{ ...finding, id }] },
      fixtureSource,
      false,
      undefined,
      [
        {
          id,
          disposition: 'disputed',
          rationale: 'Renaming is outside the agreed scope',
          requirement: 'Keep the existing public API compatible'
        }
      ]
    )
    if (gated) {
      expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(false)
    }
    accept()
    const run = store.getV2('run-1')
    expect(pipelineV2FindingLedger(run, fixtureSource, true)).toMatchObject({
      unresolvedImportant: ready ? 0 : 1,
      findings: [{ id, disposition: 'disputed', ownerAcknowledged: gated }]
    })
    expect(evaluatePipelineV2Completion(run, fixtureSource).ready).toBe(ready)
    expect(evaluatePipelineV2Completion(run, 'e'.repeat(64)).ready).toBe(false)
  }
)
it('docs_change_enters_visible_repair_route_and_no_update_rationale_allows_finish', async () => {
  createReviewed()
  checks()
  stage('approved', { stage: 'review', findings: [] })
  const changed = 'd'.repeat(64)
  const run = stage('done', { stage: 'docs', files: ['README.md'] }, changed)
  expect(evaluatePipelineV2Completion(run, changed)).toMatchObject({
    ready: false,
    currentEvidence: false,
    repairEntryStageId: 'checks'
  })
  const ports = {
    sourceRevision: async () => changed,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    checks: async () => ({ category: 'unknown' as const, body: 'Unused', results: [] }),
    startInvocation: async () => {
      throw new Error('Unexpected launch during repair transition')
    }
  }
  await advancePipelineV2(store, ports, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'running',
    stageId: 'checks',
    reason: 'pipeline_source_evidence_stale'
  })
  expect(store.eventsV2('run-1').events.at(-1)).toMatchObject({
    kind: 'revalidate',
    reason: 'pipeline_source_evidence_stale',
    stageId: 'checks'
  })
  checks(changed)
  stage('approved', { stage: 'review', findings: [] }, changed)
  stage(
    'done',
    { stage: 'docs', files: [], rationale: 'The documentation already explains the change' },
    changed
  )
  await advancePipelineV2(store, ports, 'run-1')
  expect(store.getV2('run-1').state).toBe('completed')
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), changed)).toMatchObject({
    workflowComplete: true,
    ready: true,
    currentEvidence: true
  })
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), 'e'.repeat(64)).ready).toBe(false)
})
it('research_finish_does_not_claim_reviewed_source', () => {
  store.createV2(pipelineV2AdmissionFixture())
  settleV2Stage(store)
  settleV2Stage(store)
  const run = settleV2Stage(store, 'approved')
  expect(evaluatePipelineV2Completion(run, fixtureSource)).toMatchObject({
    workflowComplete: true,
    ready: false
  })
})
it('review_discussion_keeps_its_clean_commit_and_independent_visit_identity', async () => {
  createReviewed(true)
  checks()
  const before = stage('approved', { stage: 'review', findings: [] })
  const root = before.invocations.at(-1)!
  const native = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    checks: async () => ({ category: 'unknown' as const, body: 'Unused', results: [] }),
    startInvocation: async (
      _request: unknown,
      _spec: string,
      prepared: (binding: { dispatchId: string; session: NonNullable<typeof root.session> }) => void
    ) => {
      prepared({ dispatchId: 'review-discussion', session: root.session! })
      return { state: 'ready' as const }
    }
  }
  const controller = new PipelineController(
    store,
    {
      sourceRevision: native.sourceRevision,
      reviewCommit: native.reviewCommit,
      settled: native.settled,
      checks: async () => {
        throw new Error('Unexpected legacy check')
      },
      start: async () => {
        throw new Error('Unexpected legacy worker')
      }
    },
    native
  )
  await discussPipelineV2(
    {
      store,
      controller,
      assertWorkspace: async () => {},
      sourceRevision: native.sourceRevision,
      reviewCommit: native.reviewCommit,
      wake: () => {}
    },
    {
      id: 'run-1',
      requestId: 'discuss-review',
      expectedRevision: before.revision,
      expectedInstanceId: 'instance-1',
      pin: before.pendingDecision!,
      message: 'Explain the review scope'
    }
  )
  const invocation = store.getV2('run-1').invocations.at(-1)!
  expect(invocation.reviewCommit).toBe('b'.repeat(40))
  v2Mutation(store, {
    kind: 'submit',
    invocationId: invocation.id,
    dispatchId: 'review-discussion',
    inputRevision: invocation.inputRevision,
    sourceRevision: fixtureSource,
    result: {
      status: 'result',
      outcomeId: 'approved',
      summary: 'Independent review explained',
      evidence: { stage: 'review', findings: [] }
    }
  })
  const pending = v2Mutation(store, { kind: 'settle', invocationId: invocation.id })
  v2Mutation(store, { kind: 'decide', action: 'accept', ...pending.pendingDecision! })
  expect(evaluatePipelineV2Completion(store.getV2('run-1'), fixtureSource).ready).toBe(true)
})
it('resume_finishes_a_paused_completed_stage_without_dispatching_it_again', async () => {
  createReviewed()
  checks()
  stage('approved', { stage: 'review', findings: [] })
  const paused = stage(
    'done',
    { stage: 'docs', files: [], rationale: 'No update needed' },
    fixtureSource,
    true
  )
  expect(paused.state).toBe('paused')
  v2Mutation(store, { kind: 'resume' })
  await advancePipelineV2(
    store,
    {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => 'b'.repeat(40),
      settled: async () => false,
      checks: async () => ({ category: 'unknown', body: 'Unused', results: [] }),
      startInvocation: async () => {
        throw new Error('Completed docs must not dispatch again')
      }
    },
    'run-1'
  )
  expect(store.getV2('run-1').state).toBe('completed')
  const repaired = v2Mutation(store, { kind: 'revalidate', sourceRevision: 'e'.repeat(64) })
  expect(repaired).toMatchObject({
    state: 'running',
    stageId: 'checks',
    reason: 'pipeline_source_evidence_stale'
  })
})
