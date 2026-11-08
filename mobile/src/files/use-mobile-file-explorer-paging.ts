import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FILE_READ_DIR_MAX_PAGE_ENTRIES } from '../../../src/shared/file-listing/file-dir-page'
import { hostQueryKey, type HostQueryTarget } from '../query/host-query-key'
import { hostReadClient } from '../query/host-read-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
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
  const setStatus = useCallback(
    (relativePath: string, status: FolderPagingStatus | null) => {
      setScoped((previous) => {
        // A read that outlived its worktree may still clear its own entry, never another scope's.
        if (liveScope.current !== scope && previous.scope !== scope) {
          return previous
        }
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
    async (
      relativePath: string,
      limit: number,
      read: { cancelledRefresh: boolean }
    ): Promise<'appended' | 'stale' | 'done'> => {
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
      if (queryClient.getQueryState(queryKey)?.fetchStatus === 'fetching') {
        read.cancelledRefresh = true
        await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
      }
      if (queryClient.getQueryData(queryKey) !== previous) {
        return 'stale'
      }
      queryClient.setQueryData(queryKey, next)
      return 'appended'
    },
    [client, hostId, queryClient, target]
  )

  // Show more reads one page; Search all reads until the folder ends. Each page lands in the cache,
  // so the filter shows its matches as they arrive.
  const readPages = useCallback(
    async (relativePath: string, status: 'loading' | 'searching') => {
      const limit = status === 'searching' ? FILE_READ_DIR_MAX_PAGE_ENTRIES : DIRECTORY_PAGE_SIZE
      const read = { cancelledRefresh: false }
      setStatus(relativePath, status)
      try {
        let result = await appendPage(relativePath, limit, read)
        while (
          liveScope.current === scope &&
          (status === 'searching' ? result !== 'done' : result === 'stale')
        ) {
          result = await appendPage(relativePath, limit, read)
        }
        setStatus(relativePath, null)
      } catch {
        setStatus(relativePath, 'failed')
      } finally {
        if (read.cancelledRefresh) {
          // The refresh these pages displaced runs again, now over the longer listing.
          void queryClient.invalidateQueries({
            queryKey: hostQueryKey(hostId, fileDirectoryQuery.family, target, { relativePath }),
            exact: true
          })
        }
      }
    },
    [appendPage, hostId, queryClient, scope, setStatus, target]
  )
  const showMore = useCallback(
    (relativePath: string) => readPages(relativePath, 'loading'),
    [readPages]
  )
  const searchAll = useCallback(
    (relativePath: string) => readPages(relativePath, 'searching'),
    [readPages]
  )

  const searching = useMemo(() => [...statuses.values()].includes('searching'), [statuses])

  return { folderPaging: statuses, searching, showMore, searchAll }
}
