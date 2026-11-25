import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { useMobileNativeChatFileSearch } from '../../session/native-chat/composer/attachments/use-mobile-native-chat-file-search'
import {
  flattenDirectoryCache,
  getDirectoryCacheState,
  searchResultRows,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'

type WorkspaceFileSearch = Pick<
  ReturnType<typeof useMobileNativeChatFileSearch>,
  'nativeChatFilePaths' | 'nativeChatFilesQuery' | 'loadNativeChatFiles'
>

// As the search hook keys its answers.
function normalizedSearch(text: string): string {
  return text.trim().toLowerCase().slice(0, 256)
}

/** The explorer's visible rows, folded by open folders or the workspace search's results, and what a folder tap does. */
export function useMobileFileExplorerRows({
  scope,
  directoryCache,
  expanded,
  setExpanded,
  loadDirectory,
  search
}: {
  scope: string
  directoryCache: DirectoryCache
  expanded: ReadonlySet<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  loadDirectory: (relativePath: string) => Promise<unknown>
  search: WorkspaceFileSearch
}) {
  // Held with the scope it was typed in, so a new worktree starts unfiltered without an effect.
  const [scopedFilter, setScopedFilter] = useState({ scope, text: '' })
  const filter = scopedFilter.scope === scope ? scopedFilter.text : ''
  const setFilter = useCallback((text: string) => setScopedFilter({ scope, text }), [scope])
  const filtering = filter.trim() !== ''
  const { nativeChatFilePaths, nativeChatFilesQuery, loadNativeChatFiles } = search
  useEffect(() => {
    if (filtering) {
      loadNativeChatFiles(filter)
    }
  }, [filter, filtering, loadNativeChatFiles])
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
  const answer = held?.scope === scope ? held : null
  const searchPaths = filtering && answer ? answer.paths : null
  const searchPending = filtering && answer?.query !== normalizedSearch(filter)

  const rows = useMemo<FileExplorerRow[]>(
    () =>
      filtering
        ? searchResultRows(searchPaths ?? [])
        : flattenDirectoryCache(directoryCache, expanded),
    [directoryCache, expanded, filtering, searchPaths]
  )

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
    onToggleDirectory: filtering ? revealDirectory : toggleDirectory
  }
}
