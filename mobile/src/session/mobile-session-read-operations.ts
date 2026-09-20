import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  detectedAgentsSchema,
  markdownTabDocumentSchema,
  runtimeRepoListSchema,
  sessionForwardedReplySchema,
  sessionTerminalInventorySchema,
  sessionWorktreeRecordSchema,
  terminalQuickCommandsSchema,
  workspaceFilePathsSchema
} from './session-read-reply-schema'

// What the session screen reads: the terminal inventory, the repo list two screens resolve a
// workspace's connection through, the session tab snapshot, native chat's workspace paths and
// older-history page, the quick-command list, the whole `worktree.show` record and a markdown
// tab's document. Each schema lives in session-read-reply-schema.ts with the consumer line behind
// every requirement.

/**
 * The terminal inventory. A refused list leaves the strip exactly as it was — the screen treats it
 * as "no news", not as an empty host — which is what the skip policy says and what the throwing
 * policies would get wrong.
 */
export const sessionTerminalListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.list',
    method: 'terminal.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-inventory', sessionTerminalInventorySchema)
  })
)

export type MobileRuntimeRepoSummary = { id: string; connectionId?: string | null }

const repoListReader = rpcResultVariant('runtime-repo-list', runtimeRepoListSchema)

/**
 * The repo list. Call sites disagree about a refusal, so each of the two operations below declares
 * its own policy over the same reader rather than sharing one, and every consumer joins whichever
 * policy it already had.
 *
 * Throw-message: the new-tab agent loader and the terminal accessory's connection lookup both
 * resolve one workspace's connection id and raise the host's message without the list, and the
 * tasks route keeps the whole list for its repo pickers.
 *
 * Skip: the native-chat readability probe answers "not readable" and lets the screen render, and
 * the new-workspace dialog's repo refresh leaves the list it already has.
 */
export const newTabRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-for-new-tab',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)

export const nativeChatRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-or-unreadable',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)

/**
 * The agents a host reports for a workspace. Both the local and the remote probe read the payload
 * as the list it is, and the loader raises the host's message when either refuses.
 *
 * Separate from the task drawer's readers on the same two methods, which skip: there detection is
 * advisory and an empty set is a fine answer, where this loader gates a tab the user is opening and
 * has to say why no agent came back. Different acceptance, so two operations.
 */
export const preflightDetectAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-agents',
    method: 'preflight.detectAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)

export const preflightDetectRemoteAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agents', detectedAgentsSchema)
  })
)

/**
 * The session tab snapshot the reconciliation controller polls. Its own generation, barrier and
 * application-revision guards decide whether a reply may be applied, all of which run before the
 * payload is read, so the controller keeps the raw reply and reports the refusal to its owner.
 */
export const sessionTabsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-list',
    method: 'session.tabs.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tabs-snapshot', sessionForwardedReplySchema)
  })
)

/**
 * The two ways native chat gets workspace paths. Both answer the same `relativePath` list, and
 * both refuse by leaving the suggestion list alone — the search's `method_not_found` is read raw
 * beforehand, because that code is what makes the composer fall back to the full inventory.
 */
export const nativeChatFileSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.search-paths-or-skip',
    method: 'files.searchPaths',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)

export const nativeChatFileInventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)

/**
 * The older-history page native chat asks for when the transcript is scrolled back.
 *
 * A skip rather than a throw: a refused page leaves the window the subscription already delivered
 * and the scroll simply does not grow, which is what the call site's `if (!response.ok) return`
 * did. There is no screen to raise a host message on — the pane is already showing history.
 *
 * The payload stays whole rather than being narrowed to `messages`, because the reply is a union:
 * an older runtime answers `{ error }` in place of a window, and the caller discriminates on that
 * before it reads a message list. A member reader would have to pick one arm.
 */
export const nativeChatSessionPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'nativeChat.read-session-page-or-skip',
    method: 'nativeChat.readSession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-session-page', sessionForwardedReplySchema)
  })
)

/** Shared with the save leg in the write module: one list read, so neither leg can adopt `[]`. */
export const quickCommandsReader = rpcResultVariant(
  'terminal-quick-commands',
  terminalQuickCommandsSchema
)

/**
 * The quick-command list, read the same way on load and on save: the host re-normalizes and returns
 * the canonical list, and a payload the parser rejects reads as null so neither leg can adopt `[]`
 * and erase commands that still exist on the host.
 */
export const quickCommandsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.quick-commands-read',
    method: 'settings.getTerminalQuickCommands',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: quickCommandsReader
  })
)

/**
 * The worktree record as the host holds it, and the fourth reader on `worktree.show`. Two consumers
 * share it and project their own field off the member: the diff-comment loader reads
 * `diffComments`, and the session header's live title reads `displayName` through
 * `getLiveWorktreeDisplayName`. Widening either into its own family would be a second name for the
 * same wire, so the member is read whole here and narrowed at each call site.
 *
 * Two of the other three readers project a narrower value and would answer both consumers with
 * nothing: the summary keeps `{ baseRef, linkedPR }`, the review screen keeps
 * `{ diffComments, mobileDiffReview }`. The third, `fileOwnershipWorktreeRead`, reads the same
 * `worktree` member whole with the same reader shape, so acceptance is the only thing separating
 * them: a file mutation throws the host's message rather than write to the wrong host, where a
 * session screen missing its notes shows none, and a header missing a name keeps the route hint.
 */
export const sessionWorktreeRecordRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.show-record-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-record', sessionWorktreeRecordSchema)
  })
)

/**
 * A markdown tab's document. The refusal is read raw before interpretation, because a headless host
 * answers `renderer_unavailable` and the screen falls back to the file on disk — a code no
 * acceptance policy carries.
 */
export const markdownTabRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'markdown.read-tab',
    method: 'markdown.readTab',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('markdown-tab-doc', markdownTabDocumentSchema)
  })
)
