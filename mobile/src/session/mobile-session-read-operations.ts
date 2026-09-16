import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import {
  rpcUncheckedMemberReader,
  rpcUncheckedPayloadReader
} from '../transport/rpc-reader-payload'

// What the session screen reads: the terminal inventory, the repo list two screens resolve a
// workspace's connection through, the session tab snapshot, the quick-command list, the
// worktree-stored review notes and a markdown tab's document.

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
    read: rpcUncheckedPayloadReader('terminal-inventory')
  })
)

export type MobileRuntimeRepoSummary = { id: string; connectionId?: string | null }

const repoListReader = rpcUncheckedMemberReader('runtime-repo-list', 'repos')

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
    read: rpcUncheckedPayloadReader('detected-agents')
  })
)

export const preflightDetectRemoteAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('detected-agents')
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
    read: rpcUncheckedPayloadReader('session-tabs-snapshot')
  })
)

/**
 * The two ways native chat gets workspace paths. Both project the same `files[].relativePath` list,
 * and both refuse by leaving the suggestion list alone — the search's `method_not_found` is read
 * raw beforehand, because that code is what makes the composer fall back to the full inventory.
 */
export const nativeChatFileSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.search-paths-or-skip',
    method: 'files.searchPaths',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedMemberReader('workspace-files', 'files')
  })
)

export const nativeChatFileInventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedMemberReader('workspace-files', 'files')
  })
)

/** Shared with the save leg in the write module: one list read, so neither leg can adopt `[]`. */
export const quickCommandsReader = rpcUncheckedPayloadReader('terminal-quick-commands')

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
    read: rpcUncheckedMemberReader('worktree-record', 'worktree')
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
    read: rpcUncheckedPayloadReader('markdown-tab-doc')
  })
)
