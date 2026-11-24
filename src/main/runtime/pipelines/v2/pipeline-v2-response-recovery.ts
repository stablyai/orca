import type { PipelineStorePort } from '../pipeline-store-port'
import type {
  PipelineV2Run,
  PipelineV2Invocation
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2Command } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import { commandPipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import { requirePipelineV2StageEvidence } from './pipeline-v2-completion'
import { pipelineV2RequiresReviewCommit } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import type { PipelineV2ResponseObservation } from '../../../../shared/pipelines/v2/pipeline-v2-response-observation'
import { retainPipelineV2ResponseObservation } from './pipeline-v2-response-observations'

type Recovery =
  | {
      state: 'result'
      response: NonNullable<Extract<PipelineV2Command, { kind: 'reconcile' }>['response']>
    }
  | { state: 'interrupted'; observation: PipelineV2ResponseObservation }
  | undefined

export async function readPipelineV2ResponseRecovery(
  store: PipelineStorePort,
  ports: PipelineV2Ports,
  run: PipelineV2Run,
  invocation: PipelineV2Invocation
): Promise<Recovery> {
  const messageId = (await store.launchReceiptV2(invocation.id))?.responseMessageId
  if (!messageId) {
    return undefined
  }
  if (!ports.response || !ports.completeResponse) {
    throw new Error('pipeline_response_observer_unavailable')
  }
  const response = await ports.response(invocation, messageId)
  if (
    response.state !== 'completed' ||
    !response.observation ||
    response.observation.category !== 'result'
  ) {
    if (response.state === 'interrupted' && response.observation && !invocation.candidateId) {
      retainPipelineV2ResponseObservation(structuredClone(run), invocation.id, response.observation)
      return { state: 'interrupted', observation: response.observation }
    }
    throw new Error('pipeline_response_outcome_unknown')
  }
  const stage = run.definition.stages.find((value) => value.id === invocation.stageId)!
  const sourceRevision = await ports.sourceRevision(run.workspace)
  if (
    (pipelineV2RequiresReviewCommit(run.definition, stage) &&
      (await ports.reviewCommit(run.workspace)) !== invocation.reviewCommit) ||
    ((stage.kind === 'checks' ||
      (stage.kind === 'agent' && (stage.independent || stage.evidenceSchema === 'review'))) &&
      sourceRevision !== invocation.sourceRevision)
  ) {
    throw new Error('pipeline_source_changed')
  }
  requirePipelineV2StageEvidence(run, response.result)
  const result = response.result
  if (
    result.status === 'result' &&
    !stage.outcomes.some((value) => value.id === result.outcomeId)
  ) {
    throw new Error('pipeline_invalid_outcome')
  }
  return {
    state: 'result',
    response: { sourceRevision, result, observation: response.observation }
  }
}

export async function finishPipelineV2ResponseRecovery(
  store: PipelineStorePort,
  ports: PipelineV2Ports,
  run: PipelineV2Run
): Promise<PipelineV2Run> {
  const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
  if (
    !invocation?.candidateId ||
    !(await store.launchReceiptV2(invocation.id))?.responseMessageId
  ) {
    return run
  }
  try {
    const recovered = await readPipelineV2ResponseRecovery(store, ports, run, invocation)
    const response = recovered?.state === 'result' ? recovered.response : undefined
    const candidate = run.candidates.find((value) => value.id === invocation.candidateId)
    if (
      !response ||
      !candidate ||
      candidate.sourceRevision !== response.sourceRevision ||
      pipelineV2Fingerprint(candidate.result) !== pipelineV2Fingerprint(response.result)
    ) {
      throw new Error('pipeline_response_candidate_changed')
    }
    await ports.completeResponse!(invocation, candidate.result)
    return await commandPipelineV2(store, run.id, { kind: 'settle', invocationId: invocation.id })
  } catch (error) {
    await commandPipelineV2(store, run.id, {
      kind: 'uncertain',
      reason: 'pipeline_response_settlement_unconfirmed'
    })
    throw error
  }
}
