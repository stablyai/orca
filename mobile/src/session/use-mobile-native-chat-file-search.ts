import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { mobileNativeChatOperationTarget } from './mobile-native-chat-operation-target'

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_RESULT_LIMIT = 16
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20

/** Debounces current-host path searches and bounds the mobile result/cache. The
 *  legacy full-list fallback for older hosts lives in the operations provider. */
export function useMobileNativeChatFileSearch(args: {
  operations: HostSessionNativeChatOperations | null
  worktreeId: string
}): { nativeChatFilePaths: string[]; loadNativeChatFiles: (query: string) => void } {
  const { operations, worktreeId } = args
  // Path search is scoped to the workspace alone; no transcript coordinates apply.
  const target = useMemo(
    () => mobileNativeChatOperationTarget({ workspaceId: worktreeId }),
    [worktreeId]
  )
  const [nativeChatFilePaths, setNativeChatFilePaths] = useState<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequenceRef = useRef(0)
  const queryCacheRef = useRef(new Map<string, string[]>())

  useEffect(() => {
    sequenceRef.current++
    queryCacheRef.current.clear()
    operations?.resetFileSearchCache(worktreeId)
    setNativeChatFilePaths([])
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [operations, worktreeId])

  const loadNativeChatFiles = useCallback(
    (query: string) => {
      if (!operations) {
        return
      }
      const normalizedQuery = query.trim().toLowerCase().slice(0, 256)
      const cached = queryCacheRef.current.get(normalizedQuery)
      if (cached) {
        // Why: cancel and stale-out any in-flight debounced query so an older
        // request cannot later clobber this displayed cached result.
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        sequenceRef.current++
        setNativeChatFilePaths(cached)
        return
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      const sequence = ++sequenceRef.current
      setNativeChatFilePaths([])
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const applyPaths = (paths: string[] | null): void => {
          if (sequenceRef.current !== sequence || !paths) {
            return
          }
          queryCacheRef.current.set(normalizedQuery, paths)
          while (queryCacheRef.current.size > FILE_SEARCH_QUERY_CACHE_LIMIT) {
            const oldest = queryCacheRef.current.keys().next().value as string | undefined
            if (!oldest) {
              break
            }
            queryCacheRef.current.delete(oldest)
          }
          setNativeChatFilePaths(paths)
        }
        void operations
          .searchFiles(target, normalizedQuery)
          .then((paths) => applyPaths(paths ? paths.slice(0, FILE_SEARCH_RESULT_LIMIT) : null))
          .catch(() => {})
      }, FILE_SEARCH_DEBOUNCE_MS)
    },
    [operations, target]
  )

  return { nativeChatFilePaths, loadNativeChatFiles }
}
