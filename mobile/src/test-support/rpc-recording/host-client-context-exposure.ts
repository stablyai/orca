import type { Context } from 'react'
import type { OperationExposure, operationModuleLoader } from './operation-module-loader'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

export const HOST_CLIENT_CONTEXT_LOCAL = 'Ctx'

const RECORDER_HOST_CLIENT_CONTEXT = 'recorderHostClientContext'

const HOST_CLIENT_CONTEXT_MODULE = 'mobile/src/transport/client-context.tsx'

// Centralize the private context name: type checking cannot see exposure strings, so adapter-seam.test.ts pins it against product source.
export const hostClientContextExposure: OperationExposure = [
  'client-context.tsx',
  `\nexports.${RECORDER_HOST_CLIENT_CONTEXT} = ${HOST_CLIENT_CONTEXT_LOCAL};`
]

export function loadHostClientContext(
  modules: ReturnType<typeof operationModuleLoader>
): Context<RpcClientContextValue | null> {
  return modules.load<{
    [RECORDER_HOST_CLIENT_CONTEXT]: Context<RpcClientContextValue | null>
  }>(HOST_CLIENT_CONTEXT_MODULE)[RECORDER_HOST_CLIENT_CONTEXT]
}
