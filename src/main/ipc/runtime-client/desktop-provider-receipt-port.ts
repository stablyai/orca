import {
  app,
  ipcMain,
  MessageChannelMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REQUEST_BYTES,
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  PROVIDER_RECEIPT_READ_METHOD,
  PROVIDER_RECEIPT_PORT_ACQUIRE,
  PROVIDER_RECEIPT_PORT_DELIVERY,
  ReceiptCursor,
  ReceiptPortRequest,
  ReceiptRead,
  type ProviderReceiptReader
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { backendDocumentRole } from '../../backend-desktop/backend-desktop-capabilities'
import { electronDocumentEndpoint } from '../../backend-desktop/electron-document-endpoint'
import { inspectProcessSignal } from '../../daemon/endpoint/identity/daemon-process-inspection'
import type { ProviderReceiptDestination } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-credits'
import type { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import type { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../../runtime/rpc/callers/rpc-caller-identity'
import { successResponse } from '../../runtime/rpc/responses/rpc-response'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'

type ReceiptDocument = {
  endpoint: ProviderReceiptDestination
  isCurrent: () => boolean
  binding?: { reader: ProviderReceiptReader; pending: boolean; close: () => void }
  retire: () => void
}

type ReceiptWindow = {
  transport: AbortController
  postedToPid?: number
  document?: ReceiptDocument
  dispose: () => void
}

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
  private readonly windows = new Map<number, ReceiptWindow>()

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
    const window = this.windows.get(sender.id) ?? this.trackWindow(sender)
    if (window.postedToPid !== pid) {
      this.collectExitedRenderer(window)
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

  private trackWindow(sender: WebContents): ReceiptWindow {
    const id = sender.id
    const rendererGone = (): void => this.collectExitedRenderer(window)
    const window: ReceiptWindow = {
      transport: new AbortController(),
      dispose: () => {
        window.document?.retire()
        rendererGone()
        sender.off('destroyed', window.dispose)
        sender.off('render-process-gone', rendererGone)
        this.windows.delete(id)
      }
    }
    this.windows.set(id, window)
    sender.on('render-process-gone', rendererGone)
    sender.once('destroyed', window.dispose)
    return window
  }

  private collectExitedRenderer(window: ReceiptWindow): void {
    if (
      window.postedToPid !== undefined &&
      this.readers.hasUnread(window.transport.signal) &&
      inspectProcessSignal(window.postedToPid) === 'missing'
    ) {
      window.document?.retire()
      window.transport.abort()
      window.transport = new AbortController()
      window.postedToPid = undefined
    }
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
      !this.readers.canBind(endpoint, reader) ||
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
    const binding = {
      reader,
      pending: false,
      close: () => {
        port1.off('message', onMessage)
        port1.off('close', onClose)
        port1.close()
      }
    }
    const isCurrent = (): boolean => document.binding === binding && document.isCurrent()
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
        input.data.reader.generation !== reader.generation ||
        !this.readers.canRead(endpoint, input.data)
      ) {
        return
      }
      binding.pending = true
      void (async () => {
        try {
          let reply = await this.dispatcher.dispatch(
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
          if (!reply.ok) {
            if (!this.readers.canRead(endpoint, input.data)) {
              document.retire()
              return
            }
            const result = await this.readers.read(endpoint, input.data, undefined, 'closed')
            reply = successResponse('desktop-ipc', { runtimeId: this.runtimeId() }, result)
          }
          const encoded = encoder.encode(JSON.stringify(reply))
          if (!isCurrent()) {
            this.readers.suppress(endpoint)
            return
          }
          if (
            encoded.byteLength > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
            !this.readers.handoff(endpoint, encoded.byteLength, () => port1.postMessage(encoded))
          ) {
            document.retire()
            return
          }
          window.postedToPid = pid
        } catch {
          document.retire()
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
