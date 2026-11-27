import { ipcRenderer } from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  MAX_PROVIDER_RECEIPT_REQUEST_BYTES,
  PROVIDER_RECEIPT_PORT_ACQUIRE,
  PROVIDER_RECEIPT_PORT_DELIVERY,
  PROVIDER_RECEIPT_READ_METHOD,
  ReceiptRead,
  type ProviderReceiptCursor,
  type ProviderReceiptReader,
  type ProviderReceiptReply
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

type RuntimeCall = {
  method: string
  params?: unknown
  orchestration?: { contractVersion: number; requestId: string }
}

type ReceiptPort = { reader: ProviderReceiptReader; nonce: string; port: MessagePort }

let pending = false
let unread: ProviderReceiptCursor | undefined
let last: ProviderReceiptCursor | undefined
let active: ReceiptPort | undefined
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function hasCursor(value: unknown, cursor: ProviderReceiptCursor): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    value.sequence === cursor.sequence &&
    'nonce' in value &&
    value.nonce === cursor.nonce
  )
}

export function discardProviderReceiptReply(revision: ProviderReceiptCursor): void {
  if (active && unread && hasCursor(revision, unread)) {
    active.port.postMessage(encoder.encode(JSON.stringify(unread)))
    unread = undefined
  }
}

async function acquire(reader: ProviderReceiptReader): Promise<ReceiptPort> {
  if (active?.reader.id === reader.id && active.reader.generation === reader.generation) {
    return active
  }
  if (active && (active.reader.id !== reader.id || active.reader.generation >= reader.generation)) {
    throw new Error('provider_receipt_read_pending')
  }
  const nonce = crypto.randomUUID()
  const { resolve, promise } = Promise.withResolvers<MessagePort>()
  let arrived: MessagePort | undefined
  const onPort = (event: Electron.IpcRendererEvent, received: unknown): void => {
    if (received === nonce && event.ports.length === 1) {
      arrived = event.ports[0]!
      resolve(arrived)
    }
  }
  ipcRenderer.on(PROVIDER_RECEIPT_PORT_DELIVERY, onPort)
  try {
    const granted = await ipcRenderer.invoke(
      PROVIDER_RECEIPT_PORT_ACQUIRE,
      encoder.encode(JSON.stringify({ reader, nonce }))
    )
    if (granted !== true) {
      throw new Error('provider_receipt_unavailable')
    }
    const port = await promise
    active?.port.close()
    const binding = { reader, nonce, port }
    active = binding
    port.addEventListener(
      'close',
      () => {
        if (active?.port === port) {
          active = undefined
        }
      },
      { once: true }
    )
    return binding
  } catch (error) {
    arrived?.close()
    throw error
  } finally {
    ipcRenderer.off(PROVIDER_RECEIPT_PORT_DELIVERY, onPort)
  }
}

async function exchange(
  binding: ReceiptPort,
  encoded: Uint8Array
): Promise<RuntimeRpcResponse<ProviderReceiptReply>> {
  const { port, nonce } = binding
  const { resolve, reject, promise } =
    Promise.withResolvers<RuntimeRpcResponse<ProviderReceiptReply>>()
  const closed = (): void => reject(new Error('provider_receipt_sender_retired'))
  const restart = (event: Electron.IpcRendererEvent, received: unknown): void => {
    if (received === nonce && event.ports.length === 0) {
      if (active === binding) {
        active = undefined
      }
      port.close()
      closed()
    }
  }
  const receive = ({ data }: MessageEvent<unknown>): void => {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_PROVIDER_RECEIPT_REPLY_BYTES) {
      return closed()
    }
    try {
      resolve(JSON.parse(decoder.decode(data)))
    } catch {
      closed()
    }
  }
  port.addEventListener('message', receive, { once: true })
  port.addEventListener('messageerror', closed, { once: true })
  port.addEventListener('close', closed, { once: true })
  // Blink does not dispatch a peer-close event by default.
  ipcRenderer.on(PROVIDER_RECEIPT_PORT_DELIVERY, restart)
  try {
    port.start()
    port.postMessage(encoded)
    unread = undefined
    return await promise
  } finally {
    ipcRenderer.off(PROVIDER_RECEIPT_PORT_DELIVERY, restart)
    port.removeEventListener('message', receive)
    port.removeEventListener('messageerror', closed)
    port.removeEventListener('close', closed)
  }
}

async function read(args: RuntimeCall): Promise<RuntimeRpcResponse<unknown>> {
  if (pending) {
    throw new Error('provider_receipt_read_pending')
  }
  const input = ReceiptRead.safeParse(args.params)
  if (!input.success) {
    throw new Error('provider_receipt_invalid_read')
  }
  const { reader, since } = input.data
  if ((unread && !hasCursor(since, unread)) || (since && (!last || !hasCursor(since, last)))) {
    throw new Error('provider_receipt_read_pending')
  }
  const encoded = encoder.encode(JSON.stringify(input.data))
  if (encoded.byteLength > MAX_PROVIDER_RECEIPT_REQUEST_BYTES) {
    throw new Error('provider_receipt_capacity')
  }
  pending = true
  try {
    const reply = await exchange(await acquire(reader), encoded)
    if (reply.ok) {
      unread = last = reply.result.revision
    }
    return reply
  } finally {
    pending = false
  }
}

export function callRuntime(args: RuntimeCall): Promise<RuntimeRpcResponse<unknown>> {
  return args.method === PROVIDER_RECEIPT_READ_METHOD
    ? read(args)
    : ipcRenderer.invoke('runtime:call', args)
}
