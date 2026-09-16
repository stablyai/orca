import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { markdownTabDocumentSchema } from './session-read-reply-schema'
import {
  sessionCreatedTerminalTabSchema,
  sessionWriteUnreadReplySchema,
  terminalSendAcceptedSchema
} from './session-write-reply-schema'
import { quickCommandsReader } from './mobile-session-read-operations'

// The session screen's writes: terminal input from native chat and the image surfaces, the tab
// strip's rename/close/activate, the New Tab terminal create, the terminal menu's display-mode
// toggle, the markdown tab save and the quick-command save.
// The `subscribe` and `sendUnsubscribe` ports these files sit next to are a separate boundary and
// are untouched here.

/**
 * A terminal write whose whole meaning is whether the runtime took the bytes. Native chat, the two
 * image paste paths and the stop key all read exactly this and treat a refusal, a non-object result
 * and an unaccepted one as the same "not delivered" — which is what `object-result-or-null` says,
 * and the only policy that turns an unreadable result into a verdict instead of a throw.
 *
 * Separate from `terminalInputSend` despite the identical policy and reader: that family is the
 * query-reply responder and the live accessory, and these callers differ in what a *lost* reply
 * means. Here a drop is delivery-unknown and must not be retried, so the two keep their own names
 * and their own recorded families rather than sharing one.
 */
export const nativeChatTerminalWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.native-chat-write',
    method: 'terminal.send',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', terminalSendAcceptedSchema)
  })
)

/**
 * Creating a terminal tab from New Tab or a quick command.
 *
 * The reader is checked, unlike the member read #21083 landed with: `tab` and its `id` are what the
 * strip keys the new tab on, and main reached the screen with `undefined` there and failed on the
 * next property. `require-result-or-throw-message` keeps the message where it was, because that
 * policy rethrows the reader's exception rather than turning it into an incompatible verdict, so
 * the create's own `catch` reports the unreadable reply as the same failure copy.
 *
 * Throws the host's message rather than a skip because the host names the real cause — pty
 * exhaustion, a disabled agent, an unresolved worktree — and the screen shows it verbatim.
 * Collapsing every failure to one sentence is the defect this call site already fixed.
 *
 * Separate from `reviewTerminalCreateRun` despite the identical method and policy: that one creates
 * a throwaway terminal to drop a review prompt into and reads the handle to address the send, while
 * this one adopts the tab into the session strip. Sharing an operation would let a change to either
 * reply contract reach the other screen.
 */
export const sessionTabCreateTerminal = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-create-terminal',
    method: 'session.tabs.createTerminal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-terminal-tab', sessionCreatedTerminalTabSchema)
  })
)

/**
 * The terminal menu's display-mode toggle.
 *
 * A skip, and the caller reads no verdict at all, because the server does the resize and reports it
 * on the terminal's existing subscription: main awaited the envelope and looked at nothing in it, so
 * only a transport rejection was ever a failure here. Declared rather than omitted so the next
 * caller inherits a policy instead of choosing one.
 *
 * Nothing holds this policy, and that is a property of the call site rather than of the recordings:
 * with no verdict read, and the toggle's own `catch` swallowing a throw either way, swapping it for
 * `require-result-or-throw-message` moves no golden — measured. The first caller that reads a
 * verdict is what makes it observable. What the goldens do hold at this site is the method, the
 * params and the viewport pair.
 */
export const terminalDisplayModeSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.set-display-mode-or-skip',
    method: 'terminal.setDisplayMode',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-display-mode-set', sessionWriteUnreadReplySchema)
  })
)

/** Renaming a terminal. The reply body is unread: only acceptance decides whether the strip keeps
 *  the new title, and a refusal leaves the server title to the next refresh. */
export const sessionTerminalRename = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.rename',
    method: 'terminal.rename',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-renamed', sessionWriteUnreadReplySchema)
  })
)

/** Closing a terminal. Same skip policy for the same reason: a refused close must not prune the
 *  local list, because the pane is still there. */
export const sessionTerminalClose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.close',
    method: 'terminal.close',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-closed', sessionWriteUnreadReplySchema)
  })
)

/** Closing a session tab, with the same accepted-or-leave-it-alone rule as the two above. */
export const sessionTabClose = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-close',
    method: 'session.tabs.close',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tab-closed', sessionWriteUnreadReplySchema)
  })
)

/**
 * Focusing a terminal and activating a session tab. Both are sent through the cutover retry, which
 * logs the envelope's own `ok` and `error.code` and hands the raw reply back to its caller, so
 * neither is interpreted here — the acceptance is declared for the callers that eventually read a
 * verdict rather than the diagnostics.
 */
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

/**
 * Writing the review notes and the per-file review state onto the worktree record. Both call sites
 * raise the host's message on a refusal and roll their optimistic list back, so the message has to
 * survive; the reply body is never read.
 *
 * Kept separate from source-control's `worktree.set-review-link` even though the two configs match
 * today: `worktree.set` is a partial update, and these two sites write disjoint members. Sharing one
 * operation would let a change to the link save's acceptance or params reach the review screen's
 * rollback path, and the host list's pin write already proves this method carries no single policy.
 */
export const sessionWorktreeNotesWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-notes',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-notes-written', sessionWriteUnreadReplySchema)
  })
)

/** The save leg. Its reply is the canonical document, and a refusal is shown on the tab. */
export const markdownTabSave = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'markdown.save-tab',
    method: 'markdown.saveTab',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-tab-doc', markdownTabDocumentSchema)
  })
)

/** The save leg's reply is the canonical list, read exactly as the load leg reads it. */
export const quickCommandsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-write',
    method: 'settings.updateTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)
