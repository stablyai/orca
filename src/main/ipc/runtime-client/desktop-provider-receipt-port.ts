import {
  app,
  ipcMain,
  MessageChannelMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REQUEST_BYTES,
  PROVIDER_RECEIPT_DISCARD,
  PROVIDER_RECEIPT_READ_METHOD,
  PROVIDER_RECEIPT_PORT_ACQUIRE,
  PROVIDER_RECEIPT_PORT_DELIVERY,
  ReceiptCursor,
  ReceiptPortRequest
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { backendDocumentRole } from '../../backend-desktop/backend-desktop-capabilities'
import { electronDocumentEndpoint } from '../../backend-desktop/electron-document-endpoint'
import type { ProviderReceiptDestination } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-credits'
import { providerReceiptPortRequest } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-port-request'
import type { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import type { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../../runtime/rpc/callers/rpc-caller-identity'
import {
  DesktopProviderReceiptWindow,
  type ReceiptDocument
} from './desktop-provider-receipt-window'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'

const decoder = new TextDecoder('utf-8', { fatal: true })

function decodeRequest(data: unknown): unknown {
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_PROVIDER_RECEIPT_REQUEST_BYTES) {
    return undefined
  }
  try {
    return JSON.parse(decoder.decode(data))
  } catch {
    return undefined
  }
}

export class DesktopProviderReceiptPort {
  private readonly windows = new Map<number, DesktopProviderReceiptWindow>()

  constructor(
    private readonly readers: ProviderReceiptReaders,
    private readonly dispatcher: RpcDispatcher
  ) {
    ipcMain.handle(PROVIDER_RECEIPT_PORT_ACQUIRE, (event, data: unknown) =>
      this.acquire(event, data)
    )
    ipcMain.on(PROVIDER_RECEIPT_DISCARD, this.discard)
    app.once('will-quit', () => {
      ipcMain.removeHandler(PROVIDER_RECEIPT_PORT_ACQUIRE)
      ipcMain.off(PROVIDER_RECEIPT_DISCARD, this.discard)
      for (const window of this.windows.values()) {
        window.dispose()
      }
    })
  }

  private discard = (event: IpcMainEvent, bytes: unknown): void => {
    const { sender, senderFrame } = event
    const document = this.windows.get(sender.id)?.document
    if (!document?.isCurrent() || senderFrame !== sender.mainFrame) {
      return
    }
    const cursor = ReceiptCursor.safeParse(decodeRequest(bytes))
    if (cursor.success) {
      this.readers.discard(document.endpoint, cursor.data)
    }
  }

  endpointFor(event: IpcMainInvokeEvent): ProviderReceiptDestination | undefined {
    const admitted = this.currentDocument(event)
    return admitted && this.readers.canBind(admitted.document.endpoint)
      ? admitted.document.endpoint
      : undefined
  }

  private currentDocument(event: IpcMainInvokeEvent) {
    const { sender, senderFrame } = event
    if (
      sender.isDestroyed() ||
      !senderFrame ||
      senderFrame !== sender.mainFrame ||
      !backendDocumentRole(sender)
    ) {
      return undefined
    }
    const pid = senderFrame.osProcessId
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return undefined
    }
    const id = sender.id
    let window = this.windows.get(id)
    if (!window) {
      window = new DesktopProviderReceiptWindow(sender, this.readers, () => this.windows.delete(id))
      this.windows.set(id, window)
    }
    if (window.document?.isCurrent()) {
      return { window, document: window.document, pid, senderFrame }
    }
    window.document?.retire()
    const delivery = electronDocumentEndpoint(event)
    const lifetime = delivery.watchRetirement()
    const controller = new AbortController()
    const endpoint = { transport: window.transport.signal, document: controller.signal }
    const document: ReceiptDocument = {
      endpoint,
      isCurrent: () => !controller.signal.aborted && delivery.isCurrent(),
      isFrameCurrent: delivery.isCurrent,
      retire: () => {
        if (controller.signal.aborted) {
          return
        }
        lifetime.dispose()
        lifetime.signal.removeEventListener('abort', retire)
        document.binding?.close()
        controller.abort()
        this.readers.retireDocument(endpoint)
        if (window.document === document) {
          window.document = undefined
        }
      }
    }
    const retire = (): void => document.retire()
    lifetime.signal.addEventListener('abort', retire, { once: true })
    window.document = document
    return { window, document, pid, senderFrame }
  }

  private acquire(event: IpcMainInvokeEvent, bytes: unknown): boolean {
    const request = ReceiptPortRequest.safeParse(decodeRequest(bytes))
    const admitted = request.success ? this.currentDocument(event) : undefined
    if (!request.success || !admitted) {
      return false
    }
    const { window, document, pid, senderFrame } = admitted
    const { reader, nonce } = request.data
    const { endpoint } = document
    const previous = document.binding
    if (
      !this.readers.canOpenPort(endpoint, reader) ||
      (previous &&
        (previous.pending ||
          previous.reader.id !== reader.id ||
          previous.reader.generation >= reader.generation))
    ) {
      return false
    }
    previous?.close()
    const { port1, port2 } = new MessageChannelMain()
    const lifetime = new AbortController()
    const onClose = (): void => {
      if (document.binding === binding) {
        binding.close()
        this.readers.retireDocument(endpoint)
      }
    }
    let closed = false
    const binding: NonNullable<ReceiptDocument['binding']> = {
      reader,
      pending: false,
      close: () => {
        if (closed) {
          return
        }
        closed = true
        if (document.binding === binding) {
          document.binding = undefined
          lifetime.abort()
          this.readers.suppress(endpoint)
        }
        port1.off('message', onMessage)
        port1.off('close', onClose)
        port1.close()
        // The frame token fences restart delivery even after the binding is retired.
        if (document.isFrameCurrent()) {
          try {
            senderFrame.postMessage(PROVIDER_RECEIPT_PORT_DELIVERY, nonce)
          } catch {
            // The frame disappeared before the send.
          }
        }
      }
    }
    const isCurrent = (): boolean => document.binding === binding && document.isCurrent()
    const onMessage = ({ data }: { data: unknown }): void => {
      const request = providerReceiptPortRequest(
        this.readers,
        endpoint,
        binding,
        isCurrent(),
        decodeRequest(data)
      )
      if (request.kind === 'drop') {
        return
      }
      binding.pending = true
      void (async () => {
        let posted = false
        const canPost = (): boolean => isCurrent() && this.readers.canOpenPort(endpoint, reader)
        try {
          if (request.kind !== 'read') {
            return
          }
          const dispatched = await this.dispatcher.dispatch(
            {
              id: 'desktop-ipc',
              authToken: 'desktop-ipc',
              method: PROVIDER_RECEIPT_READ_METHOD,
              params: request.input
            },
            {
              clientId: 'desktop-renderer',
              caller: DESKTOP_RPC_CALLER,
              clientKind: 'runtime',
              clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
              signal: lifetime.signal,
              localProviderReceipts: { endpoint, readers: this.readers }
            }
          )
          if (!dispatched.ok && (!isCurrent() || !this.readers.canStartRead(endpoint, reader))) {
            return
          }
          const reply = dispatched.ok
            ? dispatched.result
            : await this.readers.read(endpoint, request.input, undefined, 'closed', lifetime.signal)
          const prepared = this.readers.preparedReply(endpoint)
          posted =
            prepared !== undefined &&
            prepared.reply === reply &&
            prepared.reply.status !== 'reader_unknown' &&
            canPost() &&
            senderFrame.osProcessId === pid &&
            window.watchRenderer(pid, endpoint.document) &&
            this.readers.handoff(endpoint, (encoded) => port1.postMessage(encoded))
        } catch {
          // Failure to hand off a reply retires this binding below.
        } finally {
          binding.pending = false
          if (!posted) {
            binding.close()
          }
        }
      })()
    }
    try {
      if (!document.isCurrent() || senderFrame !== event.sender.mainFrame) {
        port1.close()
        port2.close()
        return false
      }
      document.binding = binding
      port1.on('message', onMessage)
      port1.once('close', onClose)
      port1.start()
      senderFrame.postMessage(PROVIDER_RECEIPT_PORT_DELIVERY, nonce, [port2])
      return true
    } catch {
      document.retire()
      port2.close()
      return false
    }
  }
}
