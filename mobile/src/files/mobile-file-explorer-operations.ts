import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { fileDirectoryEntriesSchema, legacyFileListSchema } from './file-explorer-reply-schema'

// Skip refusals so readDir can select the older-host fallback and files.list can supply display copy; the panel needs the raw refusal code.
// Malformed accepted listings throw into the panel’s inline load error instead of crashing a later tree render.
export const fileDirectoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.read-directory-or-skip',
    method: 'files.readDir',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('directory-entries', fileDirectoryEntriesSchema)
  })
)

// Use a separate files.list reader: the explorer needs truncated as well as files; native-chat inventory shares a files-only projection with searchPaths.
export const legacyFileListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.legacy-explorer-list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('legacy-file-list', legacyFileListSchema)
  })
)
