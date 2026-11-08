import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../worktree/session-worktree-record-reply-schema'
import '../../terminal/terminal-reply-schema'
import { sessionCreatedTerminalTabSchema } from '../../terminal/session/mobile-session-terminal-reply-schema'
import { sessionTabCloseReplySchema } from './mobile-session-tab-write-reply-schema'
import { sessionWriteUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../terminal/quick-commands/mobile-quick-command-operations'

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

export const sessionTabClose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-close',
    method: 'session.tabs.close',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tab-closed', sessionTabCloseReplySchema)
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
