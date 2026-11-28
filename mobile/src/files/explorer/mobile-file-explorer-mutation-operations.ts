import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { sessionWriteUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'

// Refusals carry the host's message (e.g. "already exists"), which the sheets show and Duplicate retries on.
export const explorerFileCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-create-file',
    method: 'files.createFile',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-file-created', sessionWriteUnreadReplySchema)
  })
)

export const explorerFolderCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-create-folder',
    method: 'files.createDir',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-folder-created', sessionWriteUnreadReplySchema)
  })
)

export const explorerPathRename = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-rename',
    method: 'files.rename',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-path-renamed', sessionWriteUnreadReplySchema)
  })
)

export const explorerFileCopy = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-duplicate',
    method: 'files.copy',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-file-copied', sessionWriteUnreadReplySchema)
  })
)

export const explorerPathDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-delete',
    method: 'files.delete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-path-deleted', sessionWriteUnreadReplySchema)
  })
)

// Settles a write whose reply was lost: one answer per path asked, in order.
export const explorerPathsExistRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-paths-exist',
    method: 'files.pathsExist',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'explorer-paths-exist',
      z.array(z.looseObject({ exists: z.boolean().optional(), error: z.string().optional() }))
    )
  })
)

// Settles a lost copy: the host writes the copy in place, so only a size equal to the source's shows it finished.
export const explorerPathStat = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-stat',
    method: 'files.stat',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'explorer-path-stat',
      z.looseObject({ size: z.number().int().nonnegative() })
    )
  })
)
