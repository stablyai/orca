import { appDocumentFor, type AppCaller } from '../app-registry/app-handler-registry'

import { abortWhenRendererGone } from './renderer-lifetime-abort'

export type SenderScopedRequestCancellations = {
  /** Registers a cancellable request; aborts any previous request that reused the token. */
  begin: (event: AppCaller, requestToken: string | undefined) => AbortController | null
  /** Removes the registration once the request settles (no-op if it was replaced). */
  finish: (
    event: AppCaller,
    requestToken: string | undefined,
    controller: AbortController | null
  ) => void
  /** Best-effort abort from the issuing webContents; a settled request is gone. */
  cancel: (event: AppCaller, requestToken: string) => void
}

type SenderRequests = {
  controllers: Map<string, AbortController>
  lifetime: ReturnType<typeof abortWhenRendererGone>
}

/** Requests belong to the issuing document; one window cannot cancel another's work. */
export function createSenderScopedRequestCancellations(): SenderScopedRequestCancellations {
  const senders = new Map<number, SenderRequests>()
  const release = (senderId: number, requests: SenderRequests): void => {
    if (senders.get(senderId) === requests) {
      senders.delete(senderId)
    }
    requests.lifetime.dispose()
  }
  const requestsFor = (event: AppCaller): SenderRequests => {
    const senderId = appDocumentFor(event).id
    let requests = senders.get(senderId)
    if (!requests) {
      const lifetime = abortWhenRendererGone(appDocumentFor(event))
      const owned: SenderRequests = { controllers: new Map(), lifetime }
      senders.set(senderId, owned)
      lifetime.signal.addEventListener(
        'abort',
        () => {
          // Detach before abort callbacks can finish old requests or register new ones.
          release(senderId, owned)
          for (const controller of owned.controllers.values()) {
            controller.abort()
          }
          owned.controllers.clear()
        },
        { once: true }
      )
      requests = owned
    }
    return requests
  }
  return {
    begin: (event, requestToken) => {
      if (!requestToken) {
        return null
      }
      senders.get(appDocumentFor(event).id)?.controllers.get(requestToken)?.abort()
      const controller = new AbortController()
      requestsFor(event).controllers.set(requestToken, controller)
      return controller
    },
    finish: (event, requestToken, controller) => {
      if (!requestToken || !controller) {
        return
      }
      const requests = senders.get(appDocumentFor(event).id)
      if (requests?.controllers.get(requestToken) === controller) {
        requests.controllers.delete(requestToken)
        if (requests.controllers.size === 0) {
          release(appDocumentFor(event).id, requests)
        }
      }
    },
    cancel: (event, requestToken) => {
      senders.get(appDocumentFor(event).id)?.controllers.get(requestToken)?.abort()
    }
  }
}
