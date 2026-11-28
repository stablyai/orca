import { useCallback, useMemo } from 'react'
import * as z from 'zod'
import type { UseQueryResult } from '@tanstack/react-query'
import type { GitFileStatus } from '../../../../src/shared/git/status/git-status-types'
import {
  buildFolderStatusMap,
  buildIgnoredSet,
  buildStatusMap,
  getPathDecoration,
  shouldShowIgnoredDecoration
} from '../../../../src/shared/git/status/git-path-decoration'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import { defineHostQuery, useHostQueries, useHostQuery } from '../../query/host-query'
import type { HostQueryTarget } from '../../query/host-query-key'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  gitStatusSummaryQuery,
  serverGitStatusSummaryQuery
} from '../../source-control/changes/mobile-git-status-query'
import { isMobileGitUnavailableReply } from '../../source-control/changes/mobile-git-status'
import {
  getDirectoryCacheState,
  joinRelativePath,
  shouldIncludeMobileFileExplorerEntry,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'

export type MobileFileDecoration = { status: GitFileStatus | null; ignored: boolean }
export type DecorateFileRow = (relativePath: string, isDirectory: boolean) => MobileFileDecoration

// The host's git.checkIgnored cap per call. A folder is asked in slices of this size in listing order, so
// "Show more" appends a slice and the earlier ones keep their cached answers.
const MAX_IGNORED_QUERY_PATHS = 2000
const NO_DECORATION: MobileFileDecoration = { status: null, ignored: false }

// Desktops before mobile could ask refuse it; the tree then shows no ignored dimming.
const gitCheckIgnoredRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.check-ignored-or-skip',
    method: 'git.checkIgnored',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ignored-paths', z.array(z.string()))
  })
)

// No file name holds a slash, so a folder's listed names travel as one key-safe string.
const NAME_SEPARATOR = '/'

// One answer per listed slice of a folder, so opening a folder asks only about its own rows.
const ignoredPathsQuery = defineHostQuery({
  family: 'git.checkIgnored',
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  fetch: async (client: RpcClient, target, input: { folder: string; names: string }) => {
    const outcome = await gitCheckIgnoredRead.request(client, {
      worktree: `id:${target.worktree ?? ''}`,
      paths: input.names.split(NAME_SEPARATOR).map((name) => joinRelativePath(input.folder, name))
    })
    const reply = gitCheckIgnoredRead.interpret(outcome)
    if (reply.accepted) {
      return reply.value
    }
    // Older desktops without git.checkIgnored return method_not_found; transient failures must retry, not cache [].
    if (isMobileGitUnavailableReply(outcome)) {
      return []
    }
    throw new Error(
      outcome.ok
        ? 'Invalid git.checkIgnored reply'
        : outcome.error.message || 'git.checkIgnored failed'
    )
  }
})

function shownRowsByFolder(rows: readonly FileExplorerRow[]): Map<string, string[]> {
  const byFolder = new Map<string, string[]>()
  for (const row of rows) {
    if (row.kind === 'directory' || row.kind === 'text' || row.kind === 'binary') {
      const slash = row.relativePath.lastIndexOf('/')
      const folder = slash === -1 ? '' : row.relativePath.slice(0, slash)
      const name = slash === -1 ? row.relativePath : row.relativePath.slice(slash + 1)
      const list = byFolder.get(folder)
      if (list) {
        list.push(name)
      } else {
        byFolder.set(folder, [name])
      }
    }
  }
  return byFolder
}

function combineIgnored(results: UseQueryResult<string[]>[]): Set<string> {
  return buildIgnoredSet(results.flatMap((result) => result.data ?? []))
}

/** Desktop's tree decorations: git status colours and letters, folders rolled up, ignored rows dimmed. */
export function useMobileFileExplorerDecorations(args: {
  host: { hostId: string; client: RpcClient | null }
  target: HostQueryTarget & { worktree: string }
  /** Hosts old enough to need the whole-tree fallback get no decorations. */
  enabled: boolean
  directoryCache: DirectoryCache
  rows: readonly FileExplorerRow[]
}): DecorateFileRow {
  const { host, target, directoryCache, rows } = args
  // Folder workspaces have no repository to read status or ignore rules from.
  const enabled = args.enabled && !target.worktree.startsWith('folder:')
  const { data: status } = useHostQuery(
    target.exec === LOCAL_EXECUTION_HOST_ID ? gitStatusSummaryQuery : serverGitStatusSummaryQuery,
    host,
    target,
    {},
    { enabled }
  )
  const entries = status?.kind === 'ready' ? status.status.entries : undefined
  const statusByPath = useMemo(() => buildStatusMap(entries ?? []), [entries])
  const folderStatusByPath = useMemo(() => buildFolderStatusMap(entries ?? []), [entries])

  // Only a repository answers status, and only folders with rows on screen are asked about.
  const repository = enabled && status?.kind === 'ready' && !status.status.readError
  const shownByFolder = useMemo(
    () => (repository ? shownRowsByFolder(rows) : new Map<string, string[]>()),
    [repository, rows]
  )
  const ignoredInputs = useMemo(
    () =>
      [...shownByFolder.entries()].flatMap(([folder, visibleNames]) => {
        const cachedEntries = getDirectoryCacheState(directoryCache, folder)?.entries
        const names = cachedEntries
          ? cachedEntries.filter(shouldIncludeMobileFileExplorerEntry).map((entry) => entry.name)
          : visibleNames
        const slices = []
        for (let start = 0; start < names.length; start += MAX_IGNORED_QUERY_PATHS) {
          const slice = names.slice(start, start + MAX_IGNORED_QUERY_PATHS)
          slices.push({ folder, names: slice.join(NAME_SEPARATOR) })
        }
        return slices
      }),
    [directoryCache, shownByFolder]
  )
  const ignored = useHostQueries(ignoredPathsQuery, host, target, ignoredInputs, combineIgnored)

  return useCallback(
    (relativePath, isDirectory) => {
      const rowStatus = isDirectory
        ? getPathDecoration(folderStatusByPath, relativePath)
        : getPathDecoration(statusByPath, relativePath)
      const rowIgnored = shouldShowIgnoredDecoration(rowStatus, ignored, relativePath)
      return rowStatus === null && !rowIgnored
        ? NO_DECORATION
        : { status: rowStatus, ignored: rowIgnored }
    },
    [folderStatusByPath, ignored, statusByPath]
  )
}
