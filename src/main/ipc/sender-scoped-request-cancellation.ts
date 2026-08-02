import type { IpcMainInvokeEvent } from 'electron'

export type SenderScopedRequestCancellations = {
  /** Registers a cancellable request; aborts any previous request that reused the token. */
  begin: (event: IpcMainInvokeEvent, requestToken: string | undefined) => AbortController | null
  /** Removes the registration once the request settles (no-op if it was replaced). */
  finish: (
    event: IpcMainInvokeEvent,
    requestToken: string | undefined,
    controller: AbortController | null
  ) => void
  /** Best-effort abort from the issuing webContents; a settled request is gone. */
  cancel: (event: IpcMainInvokeEvent, requestToken: string) => void
}

/**
 * Registry for renderer-cancellable IPC requests. Keys are scoped to the
 * issuing webContents so one window's token can never cancel another window's
 * request, and reusing a token aborts the previous request before the new one
 * registers.
 */
export function createSenderScopedRequestCancellations(): SenderScopedRequestCancellations {
  const controllers = new Map<string, AbortController>()
  const keyFor = (event: IpcMainInvokeEvent, requestToken: string): string =>
    `${event.sender.id}\0${requestToken}`
  return {
    begin: (event, requestToken) => {
      if (!requestToken) {
        return null
      }
      const key = keyFor(event, requestToken)
      controllers.get(key)?.abort()
      const controller = new AbortController()
      controllers.set(key, controller)
      return controller
    },
    finish: (event, requestToken, controller) => {
      if (!requestToken || !controller) {
        return
      }
      const key = keyFor(event, requestToken)
      if (controllers.get(key) === controller) {
        controllers.delete(key)
      }
    },
    cancel: (event, requestToken) => {
      controllers.get(keyFor(event, requestToken))?.abort()
    }
  }
}
