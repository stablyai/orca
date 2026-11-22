import type { IpcMainInvokeEvent } from 'electron'
import type { DocumentDeliveryEndpoint } from '../../shared/backend/document-delivery-endpoint'
import { abortWhenRendererGone } from '../ipc/renderer-requests/renderer-lifetime-abort'

/** The document that sent this invoke, frozen to its frame at request time. */
export function electronDocumentEndpoint(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
): DocumentDeliveryEndpoint {
  const { sender, senderFrame } = event
  return {
    hostId: sender.id,
    isGone: () => sender.isDestroyed(),
    isCurrent: () =>
      !sender.isDestroyed() &&
      !!senderFrame &&
      !senderFrame.detached &&
      senderFrame === sender.mainFrame,
    send: (channel, payload) => sender.send(channel, payload),
    watchRetirement: () => abortWhenRendererGone(sender)
  }
}
