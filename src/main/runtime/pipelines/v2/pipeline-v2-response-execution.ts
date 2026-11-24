import type { PipelineStore } from '../pipeline-store'
import type {
  PipelineV2Invocation,
  PipelineV2Run
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { commandPipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import { requirePipelineV2StageEvidence } from './pipeline-v2-completion'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { pipelineV2RequiresReviewCommit } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'

export async function completePipelineV2Response(
  store: PipelineStore,
  ports: PipelineV2Ports,
  run: PipelineV2Run,
  invocation: PipelineV2Invocation,
  messageId: string
): Promise<void> {
  try {
    if (!ports.response || !ports.completeResponse) {
      throw new Error('pipeline_response_observer_unavailable')
    }
    const response = await ports.response(invocation, messageId)
    if (response.state === 'pending') {
      return
    }
    const sourceRevision = await ports.sourceRevision(run.workspace).catch(() => undefined)
    const stage = run.definition.stages.find((value) => value.id === invocation.stageId)!
    const sourceMismatch =
      (pipelineV2RequiresReviewCommit(run.definition, stage) &&
        (await ports.reviewCommit(run.workspace).catch(() => undefined)) !==
          invocation.reviewCommit) ||
      (sourceRevision !== undefined &&
        (stage.kind === 'checks' ||
          (stage.kind === 'agent' && stage.evidenceSchema === 'review')) &&
        sourceRevision !== invocation.sourceRevision)
    let observation = response.observation
    let valid = response.state === 'completed'
    if (response.state === 'completed') {
      const result = response.result
      try {
        requirePipelineV2StageEvidence(run, result)
        if (
          result.status === 'result' &&
          !stage.outcomes.some((outcome) => outcome.id === result.outcomeId)
        ) {
          throw new Error('pipeline_invalid_outcome')
        }
      } catch (error) {
        valid = false
        if (observation) {
          observation = {
            ...observation,
            category: 'malformed_result',
            validationErrors: [
              {
                path: 'result',
                code: 'stage_contract',
                message: error instanceof Error ? error.message : 'pipeline_stage_evidence_mismatch'
              }
            ]
          }
        }
      }
    }
    if (sourceMismatch && observation) {
      observation = {
        ...observation,
        providerCategory:
          observation.category === 'source_mismatch'
            ? observation.providerCategory
            : observation.category,
        category: 'source_mismatch',
        reason: 'pipeline_source_changed'
      }
    } else if (sourceRevision === undefined && observation) {
      observation = {
        ...observation,
        category: observation.category === 'result' ? 'transport_unknown' : observation.category,
        reason: 'pipeline_source_unavailable'
      }
    }
    if (observation) {
      run = commandPipelineV2(
        store,
        run.id,
        { kind: 'observe_response', invocationId: invocation.id, observation },
        `observe-response:${invocation.id}:${pipelineV2Fingerprint(observation)}`
      )
      invocation = run.invocations.find((value) => value.id === invocation.id)!
    }
    if (sourceRevision === undefined) {
      throw new Error('pipeline_source_unavailable')
    }
    if (response.state === 'unverifiable' || sourceMismatch) {
      throw new Error(
        sourceMismatch ? 'pipeline_source_changed' : 'pipeline_response_outcome_unknown'
      )
    }
    if (valid && response.state === 'completed' && invocation.state === 'running') {
      run = commandPipelineV2(
        store,
        run.id,
        {
          kind: 'submit',
          invocationId: invocation.id,
          dispatchId: invocation.dispatchId!,
          inputRevision: invocation.inputRevision,
          sourceRevision,
          result: response.result
        },
        `response:${invocation.id}`
      )
      invocation = run.invocations.find((value) => value.id === invocation.id)!
    }
    const candidate = run.candidates.find((value) => value.id === invocation.candidateId)
    if (
      candidate &&
      (sourceRevision !== candidate.sourceRevision ||
        !valid ||
        response.state !== 'completed' ||
        pipelineV2Fingerprint(candidate.result) !== pipelineV2Fingerprint(response.result))
    ) {
      throw new Error('pipeline_response_candidate_changed')
    }
    await ports.completeResponse(invocation, candidate?.result)
    commandPipelineV2(
      store,
      run.id,
      candidate
        ? { kind: 'settle', invocationId: invocation.id }
        : {
            kind: 'interrupted',
            invocationId: invocation.id,
            reason: observation
              ? `pipeline_response_${observation.category}`
              : 'pipeline_response_malformed_result'
          }
    )
  } catch (error) {
    commandPipelineV2(store, run.id, {
      kind: 'uncertain',
      reason:
        error instanceof Error && /^pipeline_[a-z_]+$/.test(error.message)
          ? error.message
          : 'pipeline_response_invalid'
    })
  }
}
