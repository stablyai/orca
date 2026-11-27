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

/** A user's call that met an idle stop (never dispatched: the host fenced first) is sent once more,
 *  and that run wakes the host (#46567). Nothing else is resent. */
export async function resumeAfterIdleStop<T>(
  attempt: () => Promise<RuntimeRpcResponse<T>>,
  wake: boolean
): Promise<RuntimeRpcResponse<T>> {
  if (!wake) {
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
