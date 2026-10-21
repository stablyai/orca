import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  terminalSendAcceptedSchema,
  terminalViewportUpdatedSchema,
  terminalWriteUnreadReplySchema
} from './terminal-reply-schema'

// Terminal input, the in-place viewport update and the buffer clear. The `subscribe` and
// `sendUnsubscribe` ports these files also reach are a separate boundary and are untouched.

/**
 * Five call sites send terminal input this way and all agree on acceptance, differing only in the
 * params they build: the query-reply responder (`mobile-terminal-query-reply.ts`), the live
 * accessory's raw send (`terminal-live-accessory-raw-send.ts`), and — in the session screen — the
 * composed draft send and the live keystroke send (`use-mobile-session-terminal-send-actions.ts`)
 * plus the clipboard paste (`use-mobile-terminal-paste.ts`). Narrowing `object-result-or-null` here
 * changes what a lost ack means for all five.
 */
export const terminalInputSend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.input-send',
    method: 'terminal.send',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', terminalSendAcceptedSchema)
  })
)

/**
 * The refit's in-place viewport update. Its capability verdict still comes off the raw reply: the
 * refusal code decides whether the method exists at all, and no acceptance policy carries a code.
 */
export const terminalViewportUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.viewport-update',
    method: 'terminal.updateViewport',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-viewport-updated', terminalViewportUpdatedSchema)
  })
)

/**
 * The worker-takeover report. It is a skip rather than a message-throw because the caller raises a
 * fixed sentence of its own on any refusal, never the host's: the report is a background write
 * whose only consumer is the retry, so a host message would have nowhere to be shown.
 */
export const workerTerminalTakeoverReport = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.worker-terminal-input-or-skip',
    method: 'orchestration.workerTerminalUserInput',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worker-terminal-input-reported', terminalWriteUnreadReplySchema)
  })
)

/**
 * The terminal menu's buffer clear. A skip rather than a throw because main never looked at the
 * envelope: it reported success on any fulfilled reply and only a transport rejection reached the
 * failure toast, so a refusal telling the user the buffer was cleared is behaviour this preserves
 * rather than repairs.
 */
export const terminalBufferClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.clear-buffer-or-skip',
    method: 'terminal.clearBuffer',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-buffer-cleared', terminalWriteUnreadReplySchema)
  })
)
