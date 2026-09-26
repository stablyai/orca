import { defineMethod, type RpcContext } from '../core'
import { RevokeRuntimeAccessParams } from '../../../../shared/rpc-contract/runtime-access-params'

function requireRuntimeAccess(ctx: RpcContext) {
  if (!ctx.runtimeAccess) {
    throw Object.assign(
      new Error('Runtime access administration requires a local host connection'),
      { code: 'forbidden' }
    )
  }
  return ctx.runtimeAccess
}

export const RUNTIME_ACCESS_METHODS = [
  defineMethod({
    name: 'runtimeAccess.list',
    params: null,
    handler: (_params, ctx) => ({ grants: requireRuntimeAccess(ctx).list() })
  }),
  defineMethod({
    name: 'runtimeAccess.revoke',
    params: RevokeRuntimeAccessParams,
    handler: (params, ctx) => {
      const revoked = requireRuntimeAccess(ctx).revoke(params.deviceId)
      if (!revoked) {
        throw Object.assign(new Error('Runtime access grant not found'), {
          code: 'runtime_access_not_found'
        })
      }
      return { revoked: true }
    }
  })
]
