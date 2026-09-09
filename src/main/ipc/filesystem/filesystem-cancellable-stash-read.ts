import type { IpcMainInvokeEvent } from 'electron'
import type { SenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'

export async function runCancellableStashRead<T>(
  cancellations: SenderScopedRequestCancellations,
  event: IpcMainInvokeEvent,
  requestToken: string | undefined,
  read: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  const controller = cancellations.begin(event, requestToken)
  try {
    return await read(controller?.signal)
  } finally {
    cancellations.finish(event, requestToken, controller)
  }
}
