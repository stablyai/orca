import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  reviewCreatedTerminalSchema,
  reviewTerminalSendAcceptedSchema,
  reviewTerminalTabsSchema
} from './review-terminal-reply-schema'

// Dropping a prompt into a fresh agent terminal: create the tab, then send the text. There is no
// higher-level agent-composer RPC on mobile, so this pair is the launch mechanism — the PR triage
// actions and the review-notes send sheet both drive it.

/**
 * A refused create is an error the caller surfaces: there is nowhere to put the prompt. The reply
 * is read for the terminal handle the send below is addressed to, so an unreadable tab is a failure
 * even though the envelope was accepted.
 */
export const reviewTerminalCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.create-review-terminal',
    method: 'session.tabs.createTerminal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-terminal-tab', reviewCreatedTerminalSchema)
  })
)

/**
 * An accepted send can still report in-band that the terminal is locked, which is a different
 * failure from a refused send and the caller says so. The reader answers that one question.
 */
export const reviewTerminalSendRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.send-review-prompt',
    method: 'terminal.send',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', reviewTerminalSendAcceptedSchema)
  })
)

/**
 * The agent terminals the send sheet lists. Third reader on `session.tabs.list`: the reveal poller
 * projects file tabs and answers null for anything else, and the reconciliation controller hands
 * its owner the snapshot whole so its own type parameter can name it. This one keeps only the
 * terminal tabs the sheet can drop a prompt into, which both of those drop.
 */
export const reviewTerminalListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.review-terminal-list',
    method: 'session.tabs.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-terminal-tabs', reviewTerminalTabsSchema)
  })
)
