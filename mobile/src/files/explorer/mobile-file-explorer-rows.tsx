import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useMobileFileContentSearch } from './use-mobile-file-content-search'
import {
  normalizeFileSearchQuery,
  type useMobileNativeChatFileSearch
} from '../../session/native-chat/composer/attachments/use-mobile-native-chat-file-search'
import {
  contentSearchRows,
  flattenDirectoryCache,
  getDirectoryCacheState,
  listedPathMatches,
  searchResultRows,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'
import { useUploadRows } from './mobile-file-explorer-upload-queue'
import { withUploadRows } from './mobile-file-explorer-upload-rows'

type WorkspaceFileSearch = Pick<
  ReturnType<typeof useMobileNativeChatFileSearch>,
  'nativeChatFilePaths' | 'nativeChatFilesQuery' | 'loadNativeChatFiles'
>

// Opened folders add at most this many matches the host's search did not return.
const LISTED_MATCH_LIMIT = 32

/** The explorer's visible rows, folded by open folders or the workspace search's results, and what a folder tap does. */
export function useMobileFileExplorerRows({
  scope,
  directoryCache,
  expanded,
  setExpanded,
  loadDirectory,
  search,
  contentSearch,
  connected
}: {
  scope: string
  directoryCache: DirectoryCache
  expanded: ReadonlySet<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  loadDirectory: (relativePath: string) => Promise<unknown>
  search: WorkspaceFileSearch
  /** Where hits inside files are searched for the same text; null where the host can't search contents. */
  contentSearch: { client: RpcClient | null; worktreeId: string } | null
  /** A search that failed while offline asks again once connected. */
  connected: boolean
}) {
  // Held with the scope it was typed in, so a new worktree starts unfiltered without an effect.
  // This workspace's uploads show inside the folders they go to.
  const uploads = useUploadRows(scope)
  const [scopedFilter, setScopedFilter] = useState({ scope, text: '' })
  const filter = scopedFilter.scope === scope ? scopedFilter.text : ''
  const setFilter = useCallback((text: string) => setScopedFilter({ scope, text }), [scope])
  const filtering = filter.trim() !== ''
  const { nativeChatFilePaths, nativeChatFilesQuery, loadNativeChatFiles } = search
  useEffect(() => {
    if (filtering) {
      loadNativeChatFiles(filter)
    }
  }, [connected, filter, filtering, loadNativeChatFiles])
  // The last answer stays up while the next query is out, so results don't blank on every keystroke.
  const [held, setHeld] = useState<{ scope: string; query: string; paths: string[] } | null>(null)
  if (
    nativeChatFilesQuery !== null &&
    (held?.scope !== scope ||
      held.query !== nativeChatFilesQuery ||
      held.paths !== nativeChatFilePaths)
  ) {
    setHeld({ scope, query: nativeChatFilesQuery, paths: nativeChatFilePaths })
  }
  const typed = normalizeFileSearchQuery(filter)
  // While the next answer is out, the last one stays only if the new text narrows it.
  const answer = held?.scope === scope && filtering && typed.startsWith(held.query) ? held : null
  const searchPending = filtering && answer?.query !== typed
  const searchPaths = useMemo(() => {
    if (!filtering) {
      return []
    }
    const found = answer?.paths ?? []
    return [
      ...found,
      ...listedPathMatches(directoryCache, filter, LISTED_MATCH_LIMIT, new Set(found))
    ]
  }, [answer, directoryCache, filter, filtering])

  const content = useMobileFileContentSearch({
    client: contentSearch?.client ?? null,
    worktreeId: contentSearch?.worktreeId ?? '',
    query: filtering ? filter : '',
    enabled: contentSearch !== null,
    connected
  })
  const contentFiles = content.result?.files
  const rows = useMemo<FileExplorerRow[]>(() => {
    if (!filtering) {
      return withUploadRows(flattenDirectoryCache(directoryCache, expanded), uploads, expanded)
    }
    const hits = contentFiles ? contentSearchRows(contentFiles) : []
    return [
      ...searchResultRows(searchPaths),
      ...(hits.length > 0
        ? [{ id: 'section:content', relativePath: '', depth: 0 as const, kind: 'section' as const }]
        : []),
      ...hits
    ]
  }, [contentFiles, directoryCache, expanded, filtering, searchPaths, uploads])

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
        }
        return next
      })
      const state = getDirectoryCacheState(directoryCache, relativePath)
      if (!expanded.has(relativePath) && !state?.loading && (!state?.entries || state.error)) {
        void loadDirectory(relativePath)
      }
    },
    [directoryCache, expanded, loadDirectory, setExpanded]
  )

  // A folder tapped in the search results opens in the tree, with its parents expanded.
  const revealDirectory = useCallback(
    (relativePath: string) => {
      setFilter('')
      const segments = relativePath.split('/')
      setExpanded((prev) => {
        const next = new Set(prev)
        for (let index = 1; index < segments.length; index += 1) {
          next.add(segments.slice(0, index).join('/'))
        }
        return next
      })
      if (!expanded.has(relativePath)) {
        toggleDirectory(relativePath)
      }
    },
    [expanded, setExpanded, setFilter, toggleDirectory]
  )

  return {
    filter,
    setFilter,
    filtering,
    rows,
    searchPending,
    contentPending: content.pending,
    onToggleDirectory: filtering ? revealDirectory : toggleDirectory
  }
}
