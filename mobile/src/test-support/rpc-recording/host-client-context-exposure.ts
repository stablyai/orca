import type { Context } from 'react'
import type { OperationExposure, operationModuleLoader } from './operation-module-loader'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

/** The module-private local `client-context.tsx` holds its React context in. */
export const HOST_CLIENT_CONTEXT_LOCAL = 'Ctx'

/** What the exposure files that local under on the mounted module. */
export const RECORDER_HOST_CLIENT_CONTEXT = 'recorderHostClientContext'

const HOST_CLIENT_CONTEXT_MODULE = 'mobile/src/transport/client-context.tsx'

/**
 * Every screen that reaches the shared client through `useAllHostClients` reads it off a context
 * `client-context.tsx` keeps module-private, so mounting one means exposing that local by name.
 *
 * One constant rather than the same string in five adapter modules. The name it reaches for is not
 * an import, so no type checker sees it and a rename of the local surfaces as a `ReferenceError`
 * mid-recording; five hand-copied spellings are five independent ways to arrive there, and
 * `adapter-seam.test.ts` both pins the local against the product source and refuses a sixth copy.
 * The cost is where the pin lives: this text is inside `recorderSha256`, so editing it re-records
 * the whole corpus rather than the five families that mount through it.
 */
export const hostClientContextExposure: OperationExposure = [
  'client-context.tsx',
  `\nexports.${RECORDER_HOST_CLIENT_CONTEXT} = ${HOST_CLIENT_CONTEXT_LOCAL};`
]

/** The exposed context, typed by the contract the provider publishes. */
export function loadHostClientContext(
  modules: ReturnType<typeof operationModuleLoader>
): Context<RpcClientContextValue | null> {
  return modules.load<{
    [RECORDER_HOST_CLIENT_CONTEXT]: Context<RpcClientContextValue | null>
  }>(HOST_CLIENT_CONTEXT_MODULE)[RECORDER_HOST_CLIENT_CONTEXT]
}
