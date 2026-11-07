import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FILE_READ_DIR_MAX_PAGE_ENTRIES } from '../../../src/shared/file-dir-page'
import { hostQueryKey, type HostQueryTarget } from '../query/host-query-key'
import { hostReadClient } from '../query/host-read-client'
import type { RpcClient } from '../transport/rpc-client'
import { DIRECTORY_PAGE_SIZE } from './file-tree'
import {
  fileDirectoryQuery,
  readNextDirectoryPage,
  type DirectoryRead
} from './mobile-file-explorer-operations'

export type FolderPagingStatus = 'loading' | 'searching' | 'failed'

const NO_STATUS: ReadonlyMap<string, FolderPagingStatus> = new Map()

/** "Show more" and "Search all" for folders the host sent in pages; each appends to the folder's cached listing. */
export function useMobileFileExplorerPaging({
  scope,
  hostId,
  client,
  target
}: {
  scope: string
  hostId: string
  client: RpcClient | null
  target: HostQueryTarget
}) {
  const queryClient = useQueryClient()
  // Held with the scope it was set in, so another worktree starts with no folder busy.
  const [scoped, setScoped] = useState({ scope, statuses: NO_STATUS })
  const statuses = scoped.scope === scope ? scoped.statuses : NO_STATUS
  // The scope on screen, or null once unmounted: a Search all stops reading a folder nobody is looking at.
  const liveScope = useRef<string | null>(scope)
  useEffect(() => {
    liveScope.current = scope
    return () => {
      liveScope.current = null
    }
  }, [scope])
  // Bumped per appended page: a closed folder's listing has no observer to re-render the filter.
  const [revision, setRevision] = useState(0)
  const setStatus = useCallback(
    (relativePath: string, status: FolderPagingStatus | null) => {
      if (liveScope.current !== scope) {
        return
      }
      setScoped((previous) => {
        const next = new Map(previous.scope === scope ? previous.statuses : NO_STATUS)
        if (status) {
          next.set(relativePath, status)
        } else {
          next.delete(relativePath)
        }
        return { scope, statuses: next }
      })
    },
    [scope]
  )

  // `stale` when a refresh replaced the listing while the page was out; the caller reads again from it.
  const appendPage = useCallback(
    async (relativePath: string, limit: number): Promise<'appended' | 'stale' | 'done'> => {
      if (!client) {
        return 'done'
      }
      const queryKey = hostQueryKey(hostId, fileDirectoryQuery.family, target, { relativePath })
      const previous = queryClient.getQueryData<DirectoryRead>(queryKey)
      const next = await readNextDirectoryPage(
        hostReadClient(client),
        target.worktree ?? '',
        relativePath,
        previous,
        limit
      )
      if (!next) {
        return 'done'
      }
      // A refresh still out started from the shorter listing and would land over these rows.
      await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
      if (queryClient.getQueryData(queryKey) !== previous) {
        return 'stale'
      }
      queryClient.setQueryData(queryKey, next)
      setRevision((value) => value + 1)
      return 'appended'
    },
    [client, hostId, queryClient, target]
  )

  const showMore = useCallback(
    async (relativePath: string) => {
      setStatus(relativePath, 'loading')
      try {
        let result = await appendPage(relativePath, DIRECTORY_PAGE_SIZE)
        while (result === 'stale' && liveScope.current === scope) {
          result = await appendPage(relativePath, DIRECTORY_PAGE_SIZE)
        }
        setStatus(relativePath, null)
      } catch {
        setStatus(relativePath, 'failed')
      }
    },
    [appendPage, scope, setStatus]
  )

  const searchAll = useCallback(
    async (relativePath: string) => {
      setStatus(relativePath, 'searching')
      try {
        // Each page lands in the cache, so the filter shows its matches as it arrives.
        let result = await appendPage(relativePath, FILE_READ_DIR_MAX_PAGE_ENTRIES)
        while (result !== 'done' && liveScope.current === scope) {
          result = await appendPage(relativePath, FILE_READ_DIR_MAX_PAGE_ENTRIES)
        }
        setStatus(relativePath, null)
      } catch {
        setStatus(relativePath, 'failed')
      }
    },
    [appendPage, scope, setStatus]
  )

  const searching = useMemo(() => [...statuses.values()].includes('searching'), [statuses])

  return { folderPaging: statuses, pagedRevision: revision, searching, showMore, searchAll }
}
