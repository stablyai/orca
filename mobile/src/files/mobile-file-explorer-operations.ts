import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * The Files tab's directory read and the capped list it falls back to.
 *
 * Both skip rather than throw, because neither refusal is an error the operation decides: the
 * `files.readDir` refusal is what selects the fallback (a desktop predating the mobile allowlist
 * answers `method_not_found`), and the `files.list` refusal supplies the message the screen shows.
 * No acceptance policy exposes a refusal code, so the panel reads the envelope's own error the way
 * `mobile-file-preview-operations.ts` does, and only these two consumers want one.
 */
export const fileDirectoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.read-directory-or-skip',
    method: 'files.readDir',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('directory-entries')
  })
)

/**
 * The legacy capped list. A second reader on `files.list`: the native-chat inventory's
 * `files.list-or-skip` reads the `files` member alone, and the explorer also needs `truncated` to
 * keep the "Showing first 5000" note. Widening that one to a payload reader would split the
 * `workspace-files` variant it shares with `files.searchPaths`, whose caller feeds both through one
 * `extractPaths`, and only move the member read into that hook — so the explorer declares its own.
 */
export const legacyFileListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.legacy-explorer-list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('legacy-file-list')
  })
)
