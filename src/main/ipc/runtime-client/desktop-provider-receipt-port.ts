import { app, ipcMain, MessageChannelMain, type IpcMainInvokeEvent } from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REQUEST_BYTES,
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  PROVIDER_RECEIPT_READ_METHOD,
  PROVIDER_RECEIPT_PORT_ACQUIRE,
  PROVIDER_RECEIPT_PORT_DELIVERY,
  ReceiptCursor,
  ReceiptPortRequest,
  ReceiptRead
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { backendDocumentRole } from '../../backend-desktop/backend-desktop-capabilities'
import { electronDocumentEndpoint } from '../../backend-desktop/electron-document-endpoint'
import type { ProviderReceiptDestination } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-credits'
import type { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import { providerReceiptEnvelope } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-frame'
import type { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../../runtime/rpc/callers/rpc-caller-identity'
import {
  DesktopProviderReceiptWindow,
  type ReceiptDocument
} from './desktop-provider-receipt-window'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

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
    private readonly dispatcher: RpcDispatcher,
    private readonly runtimeId: () => string
  ) {
    ipcMain.handle(PROVIDER_RECEIPT_PORT_ACQUIRE, (event, data: unknown) =>
      this.acquire(event, data)
    )
    app.once('will-quit', () => {
      ipcMain.removeHandler(PROVIDER_RECEIPT_PORT_ACQUIRE)
      for (const window of this.windows.values()) {
        window.dispose()
      }
    })
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
    window.observeRenderer(pid)
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
    const onClose = (): void => document.retire()
    const binding: NonNullable<ReceiptDocument['binding']> = {
      reader,
      pending: false,
      close: () => {
        if (document.binding === binding) {
          document.binding = undefined
        }
        port1.off('message', onMessage)
        port1.off('close', onClose)
        port1.close()
      }
    }
    const isCurrent = (): boolean => document.binding === binding && document.isCurrent()
    const restart = (): void => {
      this.readers.suppress(endpoint)
      binding.close()
    }
    const onMessage = ({ data }: { data: unknown }): void => {
      if (!isCurrent() || binding.pending) {
        return
      }
      const decoded = decodeRequest(data)
      const disposition = ReceiptCursor.safeParse(decoded)
      if (disposition.success) {
        this.readers.discard(endpoint, disposition.data)
        return
      }
      const input = ReceiptRead.safeParse(decoded)
      if (
        !input.success ||
        input.data.reader.id !== reader.id ||
        input.data.reader.generation !== reader.generation
      ) {
        return
      }
      const admission = this.readers.readAdmission(endpoint, input.data)
      if (admission === 'invalid') {
        return
      }
      if (admission === 'capacity') {
        restart()
        return
      }
      binding.pending = true
      void (async () => {
        try {
          const dispatched = await this.dispatcher.dispatch(
            {
              id: 'desktop-ipc',
              authToken: 'desktop-ipc',
              method: PROVIDER_RECEIPT_READ_METHOD,
              params: input.data
            },
            {
              clientId: 'desktop-renderer',
              caller: DESKTOP_RPC_CALLER,
              clientKind: 'runtime',
              clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
              signal: endpoint.document,
              localProviderReceipts: { endpoint, readers: this.readers }
            }
          )
          if (!isCurrent()) {
            this.readers.suppress(endpoint)
            return
          }
          let result = dispatched.ok ? dispatched.result : undefined
          if (!dispatched.ok) {
            if (this.readers.readAdmission(endpoint, input.data) !== 'ready') {
              restart()
              return
            }
            result = await this.readers.read(endpoint, input.data, undefined, 'closed')
          }
          const prepared = this.readers.preparedReply(endpoint)
          if (!prepared || prepared !== result) {
            restart()
            return
          }
          const encoded = encoder.encode(
            JSON.stringify(providerReceiptEnvelope(this.runtimeId(), prepared))
          )
          if (!isCurrent()) {
            this.readers.suppress(endpoint)
            return
          }
          if (
            encoded.byteLength > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
            !window.watchRenderer(pid) ||
            !this.readers.handoff(endpoint, encoded.byteLength, () => port1.postMessage(encoded))
          ) {
            restart()
          }
        } catch {
          restart()
        } finally {
          binding.pending = false
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
