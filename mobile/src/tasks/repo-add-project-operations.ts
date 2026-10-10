import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  repoAddProjectReceiptSchema,
  repoCreateResultSchema,
  serverDirectoryBrowseSchema
} from './repo-add-project-reply-schema'

// Bringing a new project onto the paired host from the Add project sheet. All three run over
// the runtime RPCs the desktop Add project dialog uses; the host resolves the clone destination
// and the create parent from its own defaults when the params omit them, so the phone never
// has to type a host path it cannot know.

/**
 * repo.clone. A refusal (bad URL, clone failure, a destination the host refuses) throws the
 * host's message; an accepted reply carries the registered repo row. A large clone can outrun
 * the generic request timeout, so callers pass `timeoutMs: REPO_CLONE_TIMEOUT_MS`
 * from workspace-create-timeout.ts.
 */
export const repoCloneRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.clone-from-url',
    method: 'repo.clone',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('cloned-repo', repoAddProjectReceiptSchema)
  })
)

/**
 * repo.create (git init). The host answers the soft `{ repo } | { error }` pair, so an
 * accepted reply still needs `'error' in reply` at the call site — the same convention the
 * hosted-base resolvers follow.
 */
export const repoCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.create-project',
    method: 'repo.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-repo', repoCreateResultSchema)
  })
)

/**
 * repo.add for a directory that already exists on the host. The first attempt sends `kind: 'git'`
 * (the desktop default, src/renderer/src/store/repos/repo-add-actions.ts:33); the host validates
 * the path and throws `Not a valid git repository` for anything else, which is the signal the
 * sheet turns into its folder-workspace confirmation — the same try-git-then-downgrade order the
 * desktop Add project dialog uses (same file, :59-92).
 */
export const repoAddExistingRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.add-existing',
    method: 'repo.add',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('added-repo', repoAddProjectReceiptSchema)
  })
)

/**
 * files.browseServerDir, the absolute-path listing the Add project sheet walks. It skips rather
 * than throws so the sheet renders the host's refusal inline and stays on the folder it was
 * showing, the way the Files tab's directory read does.
 */
export const serverDirectoryBrowseRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.browse-server-directory-or-skip',
    method: 'files.browseServerDir',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('server-directory', serverDirectoryBrowseSchema)
  })
)
