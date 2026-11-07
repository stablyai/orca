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
  const setStatus = useCallback(
    (relativePath: string, status: FolderPagingStatus | null) =>
      setScoped((previous) => {
        const next = new Map(previous.scope === scope ? previous.statuses : NO_STATUS)
        if (status) {
          next.set(relativePath, status)
        } else {
          next.delete(relativePath)
        }
        return { scope, statuses: next }
      }),
    [scope]
  )
  // Why: a Search all left running would keep reading a folder nobody is looking at.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // False once the folder has nothing more to read.
  const appendPage = useCallback(
    async (relativePath: string, limit: number): Promise<boolean> => {
      if (!client) {
        return false
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
        return false
      }
      // A refresh still out started from the shorter listing and would land over these rows.
      await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
      // A refresh that landed meanwhile replaced the listing; the next turn continues from it.
      if (queryClient.getQueryData(queryKey) === previous) {
        queryClient.setQueryData(queryKey, next)
      }
      return true
    },
    [client, hostId, queryClient, target]
  )

  const showMore = useCallback(
    async (relativePath: string) => {
      setStatus(relativePath, 'loading')
      try {
        await appendPage(relativePath, DIRECTORY_PAGE_SIZE)
        setStatus(relativePath, null)
      } catch {
        setStatus(relativePath, 'failed')
      }
    },
    [appendPage, setStatus]
  )

  const searchAll = useCallback(
    async (relativePath: string) => {
      setStatus(relativePath, 'searching')
      try {
        // Each page lands in the cache, so the filter shows its matches as it arrives.
        let more = true
        while (more && mounted.current) {
          more = await appendPage(relativePath, FILE_READ_DIR_MAX_PAGE_ENTRIES)
        }
        setStatus(relativePath, null)
      } catch {
        setStatus(relativePath, 'failed')
      }
    },
    [appendPage, setStatus]
  )

  const searching = useMemo(() => [...statuses.values()].includes('searching'), [statuses])

  return { folderPaging: statuses, searching, showMore, searchAll }
}
