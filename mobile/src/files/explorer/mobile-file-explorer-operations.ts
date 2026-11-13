import { translate } from '../../i18n/mobile-i18n'
import { defineHostQuery } from '../../query/host-query'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import {
  rpcResultVariant,
  rpcResultVariants
} from '../../transport/rpc/rpc-operation-result-reader'
import { FILE_READ_DIR_MAX_PAGE_ENTRIES } from '../../../../src/shared/file-listing/file-dir-page'
import { compareDirEntries } from '../../../../src/shared/file-listing/file-name-sort'
import {
  fileDirectoryEntriesSchema,
  fileDirectoryPageSchema,
  legacyFileListSchema
} from './file-explorer-reply-schema'
import { directoryCacheFromFileList } from './file-list-fallback'
import { DIRECTORY_PAGE_SIZE, type DirectoryCache, type MobileDirEntry } from './file-tree'

// Skip refusals so readDir can select the older-host fallback and files.list can supply display copy; the panel needs the raw refusal code.
// Malformed accepted listings throw into the panel’s inline load error instead of crashing a later tree render.
export const fileDirectoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.read-directory-or-skip',
    method: 'files.readDir',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariants<'directory-page' | 'directory-entries', DirectoryPage>([
      rpcResultVariant('directory-page', fileDirectoryPageSchema),
      rpcResultVariant(
        'directory-entries',
        fileDirectoryEntriesSchema.transform((entries) => ({
          entries,
          total: entries.length,
          hasMore: false,
          whole: true
        }))
      )
    ])
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

type DirectoryPage = { entries: MobileDirEntry[]; total: number; hasMore: boolean; whole?: boolean }

export type DirectoryRead =
  | ({ kind: 'directory' } & DirectoryPage)
  // Older hosts: the whole tree from one capped files.list, so no folder reads its own listing.
  | { kind: 'legacy'; cache: DirectoryCache; truncated: boolean }

function loadFailed(): string {
  return translate('files.fileExplorerPanel.loadFailed', 'Unable to load files')
}

async function readDirectoryPage(
  client: RpcClient,
  worktreeId: string,
  relativePath: string,
  after: MobileDirEntry | undefined,
  limit: number
): Promise<DirectoryRead> {
  const worktree = `id:${worktreeId}`
  const response = await fileDirectoryRead.request(client, {
    worktree,
    relativePath,
    ...(after ? { after: { name: after.name, isDirectory: after.isDirectory } } : {}),
    limit
  })
  const directory = fileDirectoryRead.interpret(response)
  if (directory.accepted) {
    const { entries, total, hasMore, whole } = directory.value
    // A host older than paging ignores the cursor and sends the whole folder; keep what follows it.
    const rows =
      whole && after ? entries.filter((entry) => compareDirEntries(entry, after) > 0) : entries
    return { kind: 'directory', entries: rows, total, hasMore }
  }
  const refusal = response.ok ? undefined : response.error
  // Older desktops lack readDir in the mobile allowlist; fall back to capped files.list.
  if (
    relativePath === '' &&
    !after &&
    isMobileMethodUnavailableError(refusal?.code, refusal?.message)
  ) {
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

/** The page after `previous`'s last row, or null when that folder has no more to read. */
export async function readNextDirectoryPage(
  client: RpcClient,
  worktreeId: string,
  relativePath: string,
  previous: DirectoryRead | undefined,
  limit: number
): Promise<DirectoryRead | null> {
  if (previous?.kind !== 'directory' || !previous.hasMore) {
    return null
  }
  const next = await readDirectoryPage(
    client,
    worktreeId,
    relativePath,
    previous.entries.at(-1),
    limit
  )
  return next.kind === 'directory'
    ? { ...next, entries: [...previous.entries, ...next.entries] }
    : null
}

// A refresh reads as many rows as were shown, so pages the user opened survive a reconnect.
async function readDirectory(
  client: RpcClient,
  worktreeId: string,
  relativePath: string,
  previous: DirectoryRead | undefined
): Promise<DirectoryRead> {
  const shown = previous?.kind === 'directory' ? previous.entries.length : 0
  const pageLimit = (read: number) =>
    Math.min(FILE_READ_DIR_MAX_PAGE_ENTRIES, Math.max(DIRECTORY_PAGE_SIZE, shown - read))
  let read = await readDirectoryPage(client, worktreeId, relativePath, undefined, pageLimit(0))
  while (read.kind === 'directory' && read.hasMore && read.entries.length < shown) {
    const next = await readNextDirectoryPage(
      client,
      worktreeId,
      relativePath,
      read,
      pageLimit(read.entries.length)
    )
    if (!next) {
      break
    }
    read = next
  }
  return read
}

// One listing per folder, so reopening a folder paints its last rows while it revalidates.
export const fileDirectoryQuery = defineHostQuery({
  family: 'files.readDir',
  fetch: (client, target, input: { relativePath: string }, previous: DirectoryRead | undefined) =>
    readDirectory(client, target.worktree ?? '', input.relativePath, previous)
})
