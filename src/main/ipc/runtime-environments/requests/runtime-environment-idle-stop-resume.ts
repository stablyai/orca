import { RUNTIME_IDLE_STOPPED_ERROR_CODE } from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-stop-signal'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

function isIdleStopRefusal(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === RUNTIME_IDLE_STOPPED_ERROR_CODE
  )
}

/**
 * A user's request that met its host's idle stop runs once more, and that run's preparation wakes
 * the host. Safe to resend: the host fenced admission before it stopped, so a request refused or
 * left unanswered by that stop was never dispatched (#46567). A poll is not resent; it stays parked.
 */
export async function resumeAfterIdleStop<T>(
  attempt: () => Promise<RuntimeRpcResponse<T>>,
  background: boolean | undefined
): Promise<RuntimeRpcResponse<T>> {
  if (background) {
    return attempt()
  }
  try {
    const response = await attempt()
    if (response.ok || !isIdleStopRefusal(response.error)) {
      return response
    }
  } catch (error) {
    if (!isIdleStopRefusal(error)) {
      throw error
    }
  }
  return attempt()
}
