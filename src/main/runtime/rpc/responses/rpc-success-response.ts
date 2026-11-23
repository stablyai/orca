import type { RpcEnvelopeMeta, RpcSuccess } from '../core'

export function successResponse(id: string, meta: RpcEnvelopeMeta, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: meta }
}
