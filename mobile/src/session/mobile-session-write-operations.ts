import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { markdownTabDocumentSchema, sessionWorktreeRecordSchema } from './session-read-reply-schema'
import { terminalSendAcceptedSchema } from '../terminal/terminal-reply-schema'
import {
  sessionCreatedTerminalTabSchema,
  sessionWriteUnreadReplySchema
} from './session-write-reply-schema'
import { quickCommandsReader } from './mobile-session-read-operations'

// Keep chat writes distinct from query/accessory responders: losing a reply here means unknown delivery and forbids automatic retry.
export const nativeChatTerminalWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.native-chat-write',
    method: 'terminal.send',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', terminalSendAcceptedSchema)
  })
)

// Require a readable tab/id before adopting a create into the strip; preserve host refusal text for the user. Review-only creates instead need a handle to send to.
export const sessionTabCreateTerminal = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-create-terminal',
    method: 'session.tabs.createTerminal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-terminal-tab', sessionCreatedTerminalTabSchema)
  })
)

// Display-mode replies are unread; resize arrives on the existing subscription, and only transport rejection reaches the caller.
export const terminalDisplayModeSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.set-display-mode-or-skip',
    method: 'terminal.setDisplayMode',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-display-mode-set', sessionWriteUnreadReplySchema)
  })
)

export const sessionTerminalRename = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.rename',
    method: 'terminal.rename',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-renamed', sessionWriteUnreadReplySchema)
  })
)

export const sessionTerminalClose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.close',
    method: 'terminal.close',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-closed', sessionWriteUnreadReplySchema)
  })
)

export const sessionTabClose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-close',
    method: 'session.tabs.close',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tab-closed', sessionWriteUnreadReplySchema)
  })
)

// Cutover retry reads raw acceptance/error codes before returning focus/activation replies to callers.
export const sessionTerminalFocus = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.focus',
    method: 'terminal.focus',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-focused', sessionWriteUnreadReplySchema)
  })
)

export const sessionTabActivate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-activate',
    method: 'session.tabs.activate',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tab-activated', sessionWriteUnreadReplySchema)
  })
)

// Preserve host refusal text for optimistic rollback; the reply's record carries the host's merged notes.
export const sessionWorktreeNotesWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-notes',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // Acceptance stays as before; an unreadable record only means no merged notes to show.
    read: rpcResultVariant('worktree-notes-written', sessionWorktreeRecordSchema.catch(undefined))
  })
)

export const markdownTabSave = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'markdown.save-tab',
    method: 'markdown.saveTab',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-tab-doc', markdownTabDocumentSchema)
  })
)

export const quickCommandsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-write',
    method: 'settings.updateTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)
