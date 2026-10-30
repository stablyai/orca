import type { DaemonRequest } from './types'
import type { DaemonRequestRouterOptions } from './daemon-request-router'
export async function cancelDaemonCreateOrAttach(
  options: DaemonRequestRouterOptions,
  clientId: string,
  request: Extract<DaemonRequest, { type: 'cancelCreateOrAttach' }>
): Promise<unknown> {
  return {
    canceled: options.preparations.cancel(request.payload.sessionId, {
      clientId,
      ...(typeof request.payload.requestId === 'string'
        ? { requestId: request.payload.requestId }
        : {})
    })
  }
}
