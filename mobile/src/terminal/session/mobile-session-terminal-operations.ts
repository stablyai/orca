import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { terminalComposerDraftSchema, terminalSendAcceptedSchema } from '../terminal-reply-schema'
import { sessionTerminalInventorySchema } from './mobile-session-terminal-reply-schema'
import '../../session/agent-launch/mobile-agent-detection-reply-schema'
import '../../files/session-documents/mobile-markdown-tab-reply-schema'
import { sessionWriteUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../worktree/session-worktree-record-reply-schema'
import '../../session/native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../quick-commands/mobile-quick-command-reply-schema'
import '../../files/workspace-file-paths-reply-schema'

export const nativeChatTerminalDraftRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.native-chat-draft',
    method: 'terminal.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-composer-draft', terminalComposerDraftSchema)
  })
)

// Skip refused inventories as no news; an empty list would erase the existing strip.
export const sessionTerminalListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.list',
    method: 'terminal.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-inventory', sessionTerminalInventorySchema)
  })
)

import '../../session/tabs/mobile-session-tab-write-reply-schema'
import '../quick-commands/mobile-quick-command-operations'

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
