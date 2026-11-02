import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcEnvelopeMeta, RpcRequest } from './core'
import { successResponse } from './errors'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'

export function createDispatcherStreamingFeatureEmitter(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  reply: (response: string) => void
) {
  const recordedFeatureInteractions = new Set<FeatureInteractionId>()
  const emit = (result: unknown): void => {
    recordRuntimeFeatureInteraction(
      runtime,
      request.method,
      result,
      recordedFeatureInteractions,
      request.params
    )
    const response = successResponse(request.id, meta, result)
    response.streaming = true
    reply(JSON.stringify(response))
  }
  return { emit, recordedFeatureInteractions }
}
