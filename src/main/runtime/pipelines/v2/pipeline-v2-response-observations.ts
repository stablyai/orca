import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2ResponseObservation } from '../../../../shared/pipelines/v2/pipeline-v2-response-observation'

export function retainPipelineV2ResponseObservation(
  run: PipelineV2Run,
  invocationId: string,
  observation: PipelineV2ResponseObservation
): void {
  const invocation = run.invocations.find((value) => value.id === invocationId)
  if (!invocation || invocation.id !== run.activeInvocationId) {
    throw new Error('pipeline_invocation_conflict')
  }
  const previous = invocation.responseObservation
  if (previous && JSON.stringify(previous) !== JSON.stringify(observation)) {
    if (
      previous.requestMessageId !== observation.requestMessageId ||
      previous.clientMessageId !== observation.clientMessageId ||
      previous.turnItemId !== observation.turnItemId ||
      previous.responseItemId !== observation.responseItemId ||
      previous.rawDigest !== observation.rawDigest
    ) {
      throw new Error('pipeline_response_candidate_changed')
    }
    const history = invocation.responseHistory ?? []
    if (history.length >= 8) {
      throw new Error('pipeline_response_observation_limit')
    }
    invocation.responseHistory = [...history, previous]
  }
  invocation.responseObservation = observation
}
