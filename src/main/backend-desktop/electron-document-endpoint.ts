import type { IpcMainInvokeEvent } from 'electron'
import type { DocumentDeliveryEndpoint } from '../../shared/backend/document-delivery-endpoint'
import { abortWhenRendererGone } from '../ipc/renderer-requests/renderer-lifetime-abort'
import { addFanoutListeners } from '../runtime/events/event-listener-fanout'
import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'

// An error page commits without did-navigate; these fire after it, so a token check retires on them.
const DOCUMENT_REPLACEMENT_EVENTS = ['did-fail-load', 'dom-ready'] as const
const DOCUMENT_REFUSAL_BREADCRUMB_INTERVAL_MS = 60_000
const DOCUMENT_REPLACED_MESSAGE = 'The window that started this request moved to another page'

function readFrameToken(frame: { readonly frameToken: string } | null | undefined): string | null {
  try {
    return frame?.frameToken || null
  } catch {
    // A crashed frame throws on access.
    return null
  }
}

/** The document that sent this invoke, pinned by its frame token at request time. A token names one
 *  frame host, so a same-host replacement (a `javascript:` URL or XSLT document) is not detected. */
export function electronDocumentEndpoint(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
): DocumentDeliveryEndpoint {
  const { sender, senderFrame } = event
  // Why a token, not the WebFrameMain: Electron re-points one object at every later document of the
  // frame, and leaves `detached` set on the live frame after a crash reload.
  const documentToken = readFrameToken(senderFrame)
  const isCurrent = (): boolean =>
    !sender.isDestroyed() &&
    documentToken !== null &&
    readFrameToken(sender.mainFrame) === documentToken
  return {
    hostId: sender.id,
    isGone: () => sender.isDestroyed(),
    isCurrent: () => {
      if (isCurrent()) {
        return true
      }
      if (!sender.isDestroyed()) {
        recordCoalescedDurableCrashBreadcrumb({
          name: 'renderer_document_refused',
          data: {
            isCrashed: sender.isCrashed(),
            hasFrame: documentToken !== null,
            liveFrame: readFrameToken(sender.mainFrame) !== null
          },
          coalesceKey: `renderer_document_refused:${sender.id}`,
          minIntervalMs: DOCUMENT_REFUSAL_BREADCRUMB_INTERVAL_MS
        })
      }
      return false
    },
    // Fenced per send: between a replacement commit and its retirement event, nothing reaches the new page.
    send: (channel, payload) => {
      if (isCurrent()) {
        sender.send(channel, payload)
      }
    },
    watchRetirement: () => {
      const controller = new AbortController()
      const rendererLifetime = abortWhenRendererGone(sender)
      const releaseReplacement = addFanoutListeners(sender, DOCUMENT_REPLACEMENT_EVENTS, () => {
        if (!isCurrent()) {
          controller.abort(new Error(DOCUMENT_REPLACED_MESSAGE))
        }
      })
      const forwardGone = (): void => controller.abort(rendererLifetime.signal.reason)
      rendererLifetime.signal.addEventListener('abort', forwardGone, { once: true })
      const dispose = (): void => {
        rendererLifetime.signal.removeEventListener('abort', forwardGone)
        rendererLifetime.dispose()
        releaseReplacement()
      }
      controller.signal.addEventListener('abort', dispose, { once: true })
      return { signal: controller.signal, dispose }
    }
  }
}
