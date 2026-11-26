import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { currentPipelineV2Visit, followPipelineV2Target } from './pipeline-v2-routing'
import { settlePipelineV2Invocation, submitPipelineV2Invocation } from './pipeline-v2-invocations'
import type { PipelineV2Command } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import { retainPipelineV2ResponseObservation } from './pipeline-v2-response-observations'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

export function reconcilePipelineV2Invocation(
  run: PipelineV2Run,
  invocationId: string,
  response?: Extract<PipelineV2Command, { kind: 'reconcile' }>['response']
) {
  const invocation = run.invocations.find((value) => value.id === invocationId)
  if (
    run.state !== 'reconciliation_required' ||
    run.activeInvocationId !== invocationId ||
    !invocation?.session ||
    !invocation.dispatchId
  ) {
    throw new Error('pipeline_reconciliation_required')
  }
  if (response) {
    retainPipelineV2ResponseObservation(run, invocationId, response.observation)
    if (invocation.candidateId) {
      const candidate = run.candidates.find((value) => value.id === invocation.candidateId)
      if (
        !candidate ||
        candidate.sourceRevision !== response.sourceRevision ||
        pipelineV2Fingerprint(candidate.result) !== pipelineV2Fingerprint(response.result)
      ) {
        throw new Error('pipeline_response_candidate_changed')
      }
      invocation.state = 'submitted'
    } else {
      invocation.state = 'running'
      submitPipelineV2Invocation(run, {
        kind: 'submit',
        invocationId,
        dispatchId: invocation.dispatchId,
        inputRevision: invocation.inputRevision,
        sourceRevision: response.sourceRevision,
        result: response.result
      })
    }
    run.state = 'paused'
    delete run.reason
    return
  }
  if (invocation.candidateId) {
    const candidate = run.candidates.find((value) => value.id === invocation.candidateId)
    if (
      !candidate ||
      candidate.invocationId !== invocation.id ||
      candidate.dispatchId !== invocation.dispatchId ||
      candidate.sessionId !== invocation.session.sessionId
    ) {
      throw new Error('pipeline_candidate_conflict')
    }
    invocation.state = 'submitted'
    run.state = 'paused'
    delete run.reason
    settlePipelineV2Invocation(run, { kind: 'settle', invocationId })
    return
  }
  invocation.state = 'settled'
  delete run.activeInvocationId
  currentPipelineV2Visit(run).state = 'interrupted'
  run.state = 'waiting_owner'
  run.waitReason =
    run.pendingDecision && run.unverifiedSessionInput ? 'session_sync' : 'interrupted'
  run.reason = invocation.responseObservation
    ? `pipeline_response_${invocation.responseObservation.category}`
    : 'pipeline_settled_without_evidence'
}
export function retryPipelineV2Visit(run: PipelineV2Run, sourceRevision: string) {
  if (
    run.activeInvocationId ||
    !['paused', 'waiting_owner'].includes(run.state) ||
    !['blocked', 'interrupted'].includes(run.waitReason ?? '') ||
    run.unverifiedSessionInput
  ) {
    throw new Error('pipeline_owner_decision_required')
  }
  if (!run.definitionEnabled) {
    throw new Error('pipeline_definition_disabled')
  }
  const visit = currentPipelineV2Visit(run)
  const candidateId = visit.candidateIds.at(-1)
  delete run.pendingDecision
  run.sourceRevision = sourceRevision
  followPipelineV2Target(
    run,
    { kind: 'stage', stageId: run.stageId },
    candidateId ? { fromVisitId: visit.id, candidateId } : undefined
  )
}
