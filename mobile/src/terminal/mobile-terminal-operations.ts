import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked, rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'
import { isTerminalSendResultAccepted } from './terminal-send-rpc-response'
import type { TerminalViewportUpdateOutcome } from './terminal-viewport-refit-state'

// Terminal input and the in-place viewport update. The `subscribe` and `sendUnsubscribe` ports
// these files also reach are a separate boundary and are untouched.

/**
 * Whether the runtime took the bytes, which is the whole of what a terminal send means to mobile:
 * a refusal, a non-object result and an unaccepted one are all "not delivered". `object-result-or-
 * null` is what makes those three the same answer, because it is the only policy that turns a
 * result the reader cannot read into null rather than a throw.
 */
const terminalSendAcceptanceReader: RpcCompatibleReader<
  Record<string, unknown>,
  'terminal-send-accepted',
  boolean
> = (raw) => rpcReadUnchecked('terminal-send-accepted', isTerminalSendResultAccepted(raw))

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
    read: terminalSendAcceptanceReader
  })
)

const terminalViewportUpdateReader: RpcCompatibleReader<
  Record<string, unknown>,
  'terminal-viewport-updated',
  TerminalViewportUpdateOutcome
> = (raw) =>
  rpcReadUnchecked('terminal-viewport-updated', {
    updated: raw.updated === true,
    applied: raw.applied === true
  })

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
    read: terminalViewportUpdateReader
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
    read: rpcUncheckedPayloadReader('worker-terminal-input-reported')
  })
)
