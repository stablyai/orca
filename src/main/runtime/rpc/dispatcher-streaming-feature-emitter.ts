import type { FeatureInteractionId } from '../../../shared/feature-interaction-catalog'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from './core'
import { successResponse } from './errors'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'

export function createDispatcherStreamingFeatureEmitter(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  meta: RpcEnvelopeMeta,
  reply: (response: RpcResponse) => void
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
    reply(response)
  }
  return { emit, recordedFeatureInteractions }
}
