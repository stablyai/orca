import { MAX_TIMER_DELAY_MS } from '../../shared/concurrency/timer-delay'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { getOptionalPositiveIntegerValueFlag } from '../orchestration/numeric-flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, type RuntimeCallOptions } from '../runtime/connection/types'
import { callNamingParentEnvironment } from './worktree-parent-environment'

/** The create request's wait from --timeout-ms; without it the client keeps its default. */
export function getWorktreeCreateCallOptions(
  flags: Map<string, string | boolean>
): RuntimeCallOptions | undefined {
  const timeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
  if (timeoutMs === undefined) {
    return undefined
  }
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--timeout-ms must be at most ${MAX_TIMER_DELAY_MS}.`
    )
  }
  return { timeoutMs }
}

export function callWorktreeCreate<
  T,
  Params extends { parentWorktree?: string; parentWorkspace?: string; crossStoreParent?: unknown } =
    Record<string, unknown>
>(
  client: RuntimeClient,
  create: Params,
  flags: Map<string, string | boolean>
): Promise<RuntimeRpcSuccess<T>> {
  return callNamingParentEnvironment<T, Params>(
    client,
    'worktree.create',
    create,
    getWorktreeCreateCallOptions(flags)
  )
}
