import type { Context } from 'react'
import type { OperationExposure, operationModuleLoader } from './operation-module-loader'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

/** The exported React context shared by the native and web providers. */
export const HOST_CLIENT_CONTEXT_LOCAL = 'RpcClientContext'

/** What the exposure files that local under on the mounted module. */
const RECORDER_HOST_CLIENT_CONTEXT = 'recorderHostClientContext'

const HOST_CLIENT_CONTEXT_MODULE = 'mobile/src/transport/rpc-client-react-context.ts'

/**
 * Every screen that reaches the shared client through `useAllHostClients` reads it off a context
 * `rpc-client-react-context.ts` exports, so mounting one exposes that shared binding by name.
 *
 * One constant rather than the same string in six adapter modules. The name it reaches for is not
 * an import, so no type checker sees it and a rename of the exported binding surfaces as a `ReferenceError`
 * mid-recording; hand-copied spellings are independent ways to arrive there, and
 * `adapter-seam.test.ts` both pins the local against the product source and refuses another inline copy.
 */
export const hostClientContextExposure: OperationExposure = [
  'rpc-client-react-context.ts',
  `\nexports.${RECORDER_HOST_CLIENT_CONTEXT} = exports.${HOST_CLIENT_CONTEXT_LOCAL};`
]

/** The exposed context, typed by the contract the provider publishes. */
export function loadHostClientContext(
  modules: ReturnType<typeof operationModuleLoader>
): Context<RpcClientContextValue | null> {
  return modules.load<{
    [RECORDER_HOST_CLIENT_CONTEXT]: Context<RpcClientContextValue | null>
  }>(HOST_CLIENT_CONTEXT_MODULE)[RECORDER_HOST_CLIENT_CONTEXT]
}
