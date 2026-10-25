import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  addedProjectReplySchema,
  createProjectReplySchema,
  gitAvailabilitySchema,
  hostDirectoryListingSchema
} from './add-project-reply-schema'

// Mutations throw the host's message so the sheet can show why the project was not added.

export const projectAddRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.add-project',
    method: 'repo.add',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('added-project', addedProjectReplySchema)
  })
)

export const projectCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.create-project',
    method: 'repo.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-project', createProjectReplySchema)
  })
)

export const projectCloneRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.clone-project',
    method: 'repo.clone',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('added-project', addedProjectReplySchema)
  })
)

// Browsing also resolves ~ and relative paths against the host's home, which repo.add requires absolute.
export const hostDirectoryBrowse = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.browse-host-directory',
    method: 'files.browseServerDir',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-directory', hostDirectoryListingSchema)
  })
)

// Advisory: a refusal leaves Git assumed present, and the host still validates the create.
export const hostGitAvailabilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.git-available-or-skip',
    method: 'repo.gitAvailable',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('git-availability', gitAvailabilitySchema)
  })
)

/** What the sheet sends with, named from an operation so no module names the raw port. */
export type AddProjectRpcSender = Parameters<typeof projectAddRun.request>[0]
