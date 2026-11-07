import { translate } from '../i18n/mobile-i18n'
import { defineHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc-client'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { fileDirectoryEntriesSchema, legacyFileListSchema } from './file-explorer-reply-schema'
import { directoryCacheFromFileList } from './file-list-fallback'
import type { DirectoryCache, MobileDirEntry } from './file-tree'

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

export type DirectoryRead =
  | { kind: 'directory'; entries: MobileDirEntry[] }
  // Older hosts: the whole tree from one capped files.list, so no folder reads its own listing.
  | { kind: 'legacy'; cache: DirectoryCache; truncated: boolean }

function loadFailed(): string {
  return translate('files.fileExplorerPanel.loadFailed', 'Unable to load files')
}

async function readDirectory(
  client: RpcClient,
  worktreeId: string,
  relativePath: string
): Promise<DirectoryRead> {
  const worktree = `id:${worktreeId}`
  const response = await fileDirectoryRead.request(client, { worktree, relativePath })
  const directory = fileDirectoryRead.interpret(response)
  if (directory.accepted) {
    return { kind: 'directory', entries: directory.value }
  }
  const refusal = response.ok ? undefined : response.error
  // Older desktops lack readDir in the mobile allowlist; fall back to capped files.list.
  if (relativePath === '' && isMobileMethodUnavailableError(refusal?.code, refusal?.message)) {
    const legacyReply = await legacyFileListRead.request(client, { worktree })
    const legacy = legacyFileListRead.interpret(legacyReply)
    if (legacy.accepted) {
      return {
        kind: 'legacy',
        cache: directoryCacheFromFileList(legacy.value.files),
        truncated: legacy.value.truncated
      }
    }
    throw new Error(
      (legacyReply.ok ? undefined : legacyReply.error)?.message || refusal?.message || loadFailed()
    )
  }
  throw new Error(refusal?.message || loadFailed())
}

// One listing per folder, so reopening a folder paints its last rows while it revalidates.
export const fileDirectoryQuery = defineHostQuery({
  family: 'files.readDir',
  fetch: (client, target, input: { relativePath: string }) =>
    readDirectory(client, target.worktree ?? '', input.relativePath)
})
