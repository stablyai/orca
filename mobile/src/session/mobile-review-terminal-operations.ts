import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  reviewCreatedTerminalSchema,
  reviewTerminalSendAcceptedSchema,
  reviewTerminalTabsSchema
} from './review-terminal-reply-schema'

// Require a readable terminal handle: an accepted create alone cannot address the following prompt send.
export const reviewTerminalCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.create-review-terminal',
    method: 'session.tabs.createTerminal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-terminal-tab', reviewCreatedTerminalSchema)
  })
)

// An accepted send may still report a locked terminal; preserve that distinction from RPC refusal.
export const reviewTerminalSendRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.send-review-prompt',
    method: 'terminal.send',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', reviewTerminalSendAcceptedSchema)
  })
)

// This reader needs sendable terminal tabs; file-only and whole-snapshot readers cannot replace it.
export const reviewTerminalListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.review-terminal-list',
    method: 'session.tabs.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-terminal-tabs', reviewTerminalTabsSchema)
  })
)
