import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  filterDirectoryCache,
  flattenDirectoryCache,
  getDirectoryCacheState,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'

/** The explorer's visible rows, folded by open folders or narrowed by the name filter, and what a folder tap does. */
export function useMobileFileExplorerRows({
  scope,
  directoryCache,
  expanded,
  setExpanded,
  loadDirectory
}: {
  scope: string
  directoryCache: DirectoryCache
  expanded: ReadonlySet<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  loadDirectory: (relativePath: string) => Promise<unknown>
}) {
  // Held with the scope it was typed in, so a new worktree starts unfiltered without an effect.
  const [scopedFilter, setScopedFilter] = useState({ scope, text: '' })
  const filter = scopedFilter.scope === scope ? scopedFilter.text : ''
  const setFilter = useCallback((text: string) => setScopedFilter({ scope, text }), [scope])
  const filtering = filter.trim() !== ''

  const rows = useMemo<FileExplorerRow[]>(
    () =>
      filtering
        ? filterDirectoryCache(directoryCache, filter)
        : flattenDirectoryCache(directoryCache, expanded),
    [directoryCache, expanded, filter, filtering]
  )

  // While filtering, a folder reads as open when its matches are listed under it.
  const shownExpanded = useMemo<ReadonlySet<string>>(() => {
    if (!filtering) {
      return expanded
    }
    const open = new Set<string>()
    rows.forEach((row, index) => {
      const next = rows[index + 1]
      if (row.kind === 'directory' && next !== undefined && next.depth > row.depth) {
        open.add(row.relativePath)
      }
    })
    return open
  }, [expanded, filtering, rows])

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

  // A folder tapped in the filter results opens in the tree, with its parents expanded.
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
    shownExpanded,
    onToggleDirectory: filtering ? revealDirectory : toggleDirectory
  }
}
