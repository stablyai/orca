import { ipcRenderer } from 'electron'
import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  PROVIDER_RECEIPT_READ_METHOD,
  type ProviderReceiptCursor,
  type ProviderReceiptReply
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

type RuntimeCall = {
  method: string
  params?: unknown
  orchestration?: { contractVersion: number; requestId: string }
}

let pending = false
let unread: ProviderReceiptCursor | undefined

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
  if (unread && hasCursor(revision, unread)) {
    ipcRenderer.send('runtime:unsubscribe', { receiptDisposition: unread })
    unread = undefined
  }
}

async function read(args: RuntimeCall): Promise<RuntimeRpcResponse<unknown>> {
  const { params } = args
  const since = params && typeof params === 'object' && 'since' in params ? params.since : null
  if (pending || (unread && !hasCursor(since, unread))) {
    throw new Error('provider_receipt_read_pending')
  }
  pending = true
  try {
    const result: Uint8Array | RuntimeRpcFailure = await ipcRenderer.invoke('runtime:call', args)
    if (!ArrayBuffer.isView(result)) {
      return result
    }
    if (result.byteLength > MAX_PROVIDER_RECEIPT_REPLY_BYTES) {
      throw new Error('provider_receipt_capacity')
    }
    // Trusted same-build IPC returns this envelope after charging its exact UTF-8 bytes.
    const reply: RuntimeRpcResponse<ProviderReceiptReply> = JSON.parse(
      new TextDecoder().decode(result)
    )
    if (reply.ok) {
      unread = reply.result.revision
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
