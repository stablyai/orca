import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked } from '../transport/rpc-reader-payload'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'

// Dropping a prompt into a fresh agent terminal: create the tab, then send the text. There is no
// higher-level agent-composer RPC on mobile, so this pair is the launch mechanism — the PR triage
// actions and the review-notes send sheet both drive it.

const createdTerminalReader: RpcCompatibleReader<
  unknown,
  'created-terminal-tab',
  MobileReviewTerminalTab | null
> = (raw) => rpcReadUnchecked('created-terminal-tab', readMobileReviewCreatedTerminal(raw))

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
    read: createdTerminalReader
  })
)

/**
 * An accepted send can still report in-band that the terminal is locked, which is a different
 * failure from a refused send and the caller says so. The reader answers that one question.
 */
const terminalSendAcceptedReader: RpcCompatibleReader<
  unknown,
  'terminal-send-accepted',
  boolean
> = (raw) => rpcReadUnchecked('terminal-send-accepted', readMobileReviewTerminalSendAccepted(raw))

export const reviewTerminalSendRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.send-review-prompt',
    method: 'terminal.send',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: terminalSendAcceptedReader
  })
)
