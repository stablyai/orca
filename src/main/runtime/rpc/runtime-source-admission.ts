import { z } from 'zod'
import type { ExpectedRuntimeSource } from '../../../shared/runtime-rpc-envelope'
import { getPublishedHostDescriptor } from '../host-descriptor'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from './core'
import { errorResponse } from './errors'

const SourceField = z.string().min(1).max(4_096)
const ExpectedRuntimeSourceSchema: z.ZodType<ExpectedRuntimeSource> = z.object({
  sourceId: SourceField,
  runtimeId: SourceField
})

/** Refuses, before any handler runs, a request whose client expects another runtime. */
export function runtimeSourceFence(request: RpcRequest, meta: RpcEnvelopeMeta): RpcResponse | null {
  if (request.expectedRuntimeSource === undefined) {
    return null
  }
  const parsed = ExpectedRuntimeSourceSchema.safeParse(request.expectedRuntimeSource)
  if (!parsed.success) {
    return errorResponse(
      request.id,
      meta,
      'bad_request',
      'Malformed expectedRuntimeSource. Nothing was run.'
    )
  }
  const sourceId = getPublishedHostDescriptor(meta.runtimeId)?.installationId
  if (!sourceId) {
    return errorResponse(
      request.id,
      meta,
      'runtime_source_unverifiable',
      'This Orca does not know which profile it serves, so it cannot confirm it is the Orca that launched this terminal. Nothing was run.'
    )
  }
  if (sourceId !== parsed.data.sourceId || meta.runtimeId !== parsed.data.runtimeId) {
    return errorResponse(
      request.id,
      meta,
      'runtime_source_mismatch',
      'This request was meant for another Orca (another profile or instance). Nothing was run. Open a new terminal from the Orca you want to control.'
    )
  }
  return null
}
