import { ipcRenderer } from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  MAX_PROVIDER_RECEIPT_REQUEST_BYTES,
  PROVIDER_RECEIPT_DISCARD,
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

type ReceiptPort = {
  reader: ProviderReceiptReader
  nonce: string
  port: MessagePort
  isRetired: () => boolean
  retire: () => void
  onRetire?: () => void
}

let pending = false
let held:
  | {
      cursor: ProviderReceiptCursor
      state: 'received' | 'consumed' | 'discarded' | 'discard-posted'
    }
  | undefined
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
  if (held && held.state !== 'discard-posted' && hasCursor(revision, held.cursor)) {
    ipcRenderer.send(PROVIDER_RECEIPT_DISCARD, encoder.encode(JSON.stringify(held.cursor)))
    held.state = 'discard-posted'
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
  let retired = false
  let binding: ReceiptPort | undefined
  const { resolve, promise } = Promise.withResolvers<MessagePort | undefined>()
  let arrived: MessagePort | undefined
  const retire = (): void => {
    if (retired) {
      return
    }
    retired = true
    ipcRenderer.off(PROVIDER_RECEIPT_PORT_DELIVERY, onDelivery)
    arrived?.removeEventListener('close', retire)
    arrived?.close()
    if (active?.nonce === nonce) {
      active = undefined
    }
    binding?.onRetire?.()
    resolve(undefined)
  }
  const onDelivery = (event: Electron.IpcRendererEvent, received: unknown): void => {
    if (received !== nonce) {
      return
    }
    if (event.ports.length === 0) {
      retire()
    } else if (!arrived && event.ports.length === 1) {
      arrived = event.ports[0]!
      arrived.addEventListener('close', retire, { once: true })
      resolve(arrived)
    }
  }
  ipcRenderer.on(PROVIDER_RECEIPT_PORT_DELIVERY, onDelivery)
  try {
    const granted = await ipcRenderer.invoke(
      PROVIDER_RECEIPT_PORT_ACQUIRE,
      encoder.encode(JSON.stringify({ reader, nonce }))
    )
    if (granted !== true) {
      throw new Error('provider_receipt_unavailable')
    }
    const port = await promise
    if (!port || retired) {
      throw new Error('provider_receipt_sender_retired')
    }
    active?.retire()
    binding = { reader, nonce, port, isRetired: () => retired, retire }
    active = binding
    return binding
  } catch (error) {
    retire()
    throw error
  }
}

async function exchange(
  binding: ReceiptPort,
  encoded: Uint8Array
): Promise<RuntimeRpcResponse<ProviderReceiptReply>> {
  const { port } = binding
  if (binding.isRetired()) {
    throw new Error('provider_receipt_sender_retired')
  }
  const { resolve, reject, promise } =
    Promise.withResolvers<RuntimeRpcResponse<ProviderReceiptReply>>()
  const closed = (): void => reject(new Error('provider_receipt_sender_retired'))
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
  // The binding's nonce listener also retires a port while no read is pending.
  binding.onRetire = closed
  try {
    port.start()
    port.postMessage(encoded)
    return await promise
  } finally {
    port.removeEventListener('message', receive)
    port.removeEventListener('messageerror', closed)
    binding.onRetire = undefined
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
  if (since ? !held || !hasCursor(since, held.cursor) : held?.state === 'received') {
    throw new Error('provider_receipt_read_pending')
  }
  pending = true
  try {
    const binding = await acquire(reader)
    if (held) {
      if (held.state === 'received' || held.state === 'consumed') {
        held.state = input.data.discarded ? 'discarded' : 'consumed'
      }
      input.data.since = held.cursor
      input.data.discarded =
        held.state === 'discarded' || held.state === 'discard-posted' || undefined
    }
    const encoded = encoder.encode(JSON.stringify(input.data))
    if (encoded.byteLength > MAX_PROVIDER_RECEIPT_REQUEST_BYTES) {
      throw new Error('provider_receipt_capacity')
    }
    const reply = await exchange(binding, encoded)
    if (reply.ok) {
      held = { cursor: reply.result.revision, state: 'received' }
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
