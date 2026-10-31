import type { Context } from 'react'
import type { OperationExposure, operationModuleLoader } from './operation-module-loader'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

export const HOST_CLIENT_CONTEXT_LOCAL = 'RpcClientContext'

const RECORDER_HOST_CLIENT_CONTEXT = 'recorderHostClientContext'

const HOST_CLIENT_CONTEXT_MODULE = 'mobile/src/transport/rpc-client-react-context.ts'

// Expose the shared context binding so recordings mount the same provider as product hooks.
export const hostClientContextExposure: OperationExposure = [
  'rpc-client-react-context.ts',
  `\nexports.${RECORDER_HOST_CLIENT_CONTEXT} = exports.${HOST_CLIENT_CONTEXT_LOCAL};`
]

export function loadHostClientContext(
  modules: ReturnType<typeof operationModuleLoader>
): Context<RpcClientContextValue | null> {
  return modules.load<{
    [RECORDER_HOST_CLIENT_CONTEXT]: Context<RpcClientContextValue | null>
  }>(HOST_CLIENT_CONTEXT_MODULE)[RECORDER_HOST_CLIENT_CONTEXT]
}
