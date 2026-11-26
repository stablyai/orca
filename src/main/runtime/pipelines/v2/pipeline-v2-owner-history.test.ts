import { expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { assemblePipelineV2Visits } from './pipeline-v2-visit-context'
import { PipelineV2VisitPage } from '../../../../shared/pipelines/v2/pipeline-v2-history-results'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

it('includes the accepted outcome and actual target for automatic stage transitions', () => {
  const store = new PipelineStore(':memory:')
  try {
    store.createV2(pipelineV2AdmissionFixture())
    const run = settleV2Stage(store)
    expect(assemblePipelineV2Visits(run, { visitCursor: 0 }).visits[0]).toMatchObject({
      outcome: { id: 'done', target: { kind: 'stage', stageId: 'implement' } },
      resultPreview: {
        summary: 'plan result',
        truncated: false,
        status: 'result',
        candidateId: run.visits[0].acceptedCandidateId
      }
    })
  } finally {
    store.close()
  }
})

it('keeps history previews bounded and pinned to the accepted candidate rather than a newer result', () => {
  const store = new PipelineStore(':memory:')
  try {
    store.createV2(pipelineV2AdmissionFixture())
    const run = settleV2Stage(store)
    run.candidates[0].summary = 'A'.repeat(321)
    run.candidates.push({
      ...run.candidates[0],
      id: 'later-result',
      summary: 'Unaccepted newer result'
    })
    run.visits[0].candidateIds.push('later-result')
    const page = PipelineV2VisitPage.parse(assemblePipelineV2Visits(run, { visitCursor: 0 }))
    expect(page.visits[0].resultPreview).toEqual({
      candidateId: run.visits[0].acceptedCandidateId,
      summary: 'A'.repeat(320),
      truncated: true,
      status: 'result'
    })
    expect(JSON.stringify(page).length).toBeLessThan(16000)
  } finally {
    store.close()
  }
})
it('distinguishes a completed attempt from passing checks and preserves a known failure alongside unknown results', () => {
  const store = new PipelineStore(':memory:')
  try {
    store.createV2(pipelineV2AdmissionFixture())
    const run = settleV2Stage(store)
    run.candidates[0].result.evidence = {
      stage: 'checks',
      results: [{ id: 'unit', code: null, timedOut: false, outputTruncated: false }]
    }
    expect(assemblePipelineV2Visits(run, { visitCursor: 0 }).visits[0]).toMatchObject({
      state: 'completed',
      resultPreview: { checkResult: 'unknown' }
    })
    run.candidates[0].result.evidence.results.push({
      id: 'lint',
      code: 1,
      timedOut: false,
      outputTruncated: false
    })
    expect(
      assemblePipelineV2Visits(run, { visitCursor: 0 }).visits[0].resultPreview?.checkResult
    ).toBe('failed')
  } finally {
    store.close()
  }
})

it('records the owner action and its actual target once with the candidate and session pins', () => {
  const store = new PipelineStore(':memory:')
  try {
    store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
    const waiting = settleV2Stage(store)
    store.ownerRequestsV2.request('decision', {
      projectId: 'project-1',
      requestId: 'owner-history-proposal',
      expectedRuntimeId: 'runtime-1',
      expectedInstanceId: 'instance-1',
      expectedRevision: waiting.revision,
      id: 'run-1',
      action: 'accept',
      pin: waiting.pendingDecision
    })
    expect(store.ownerRequestsV2.list('project-1').requests[0]).toMatchObject({
      subject: 'plan',
      action: 'accept',
      state: 'pending'
    })
    const input = {
      requestId: 'owner-accept-history',
      expectedRevision: waiting.revision,
      expectedInstanceId: 'instance-1',
      command: {
        kind: 'decide',
        ...waiting.pendingDecision!,
        action: 'accept',
        comment: 'Сохранить совместимость API.'
      }
    }
    store.commandV2('run-1', input)
    store.commandV2('run-1', input)
    const record = store.decisionsV2.forVisit('run-1', 'run-1:visit:1')
    expect(record).toMatchObject({
      requestId: 'owner-accept-history',
      action: 'accept',
      target: { kind: 'stage', stageId: 'implement' },
      outcomeId: 'done',
      comment: 'Сохранить совместимость API.',
      sessionId: 'primary-session',
      candidateId: waiting.pendingDecision!.candidateId,
      inputRevision: 0
    })
    expect(store.decisionsV2.artifact('foreign-run', record!.id)).toBeNull()
    expect(store.receiptV2('run-1', 'owner-accept-history')).toMatchObject({
      candidateId: waiting.pendingDecision!.candidateId,
      candidateDigest: waiting.pendingDecision!.candidateDigest
    })
    v2Mutation(store, { kind: 'pause' })
    expect(store.decisionsV2.forVisit('run-1', 'run-1:visit:1')).toEqual(record)
  } finally {
    store.close()
  }
})
