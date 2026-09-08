import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20
const FILE_SEARCH_RESULT_LIMIT = 16

/** Debounces current-host path searches, bounds the mobile result/cache, and
 *  falls back to the legacy one-time full list when paired to an older host. */
export function useMobileNativeChatFileSearch(args: {
  operations: HostSessionNativeChatOperations | null
  target: HostSessionNativeChatTarget | null
}): { nativeChatFilePaths: string[]; loadNativeChatFiles: (query: string) => void } {
  const { operations, target } = args
  const [nativeChatFilePaths, setNativeChatFilePaths] = useState<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequenceRef = useRef(0)
  const queryCacheRef = useRef(new Map<string, string[]>())

  useEffect(() => {
    sequenceRef.current++
    queryCacheRef.current.clear()
    setNativeChatFilePaths([])
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [operations, target?.workspaceId, target?.sessionId])

  const loadNativeChatFiles = useCallback(
    (query: string) => {
      if (!operations || !target) {
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
        const applyPaths = (paths: string[]): void => {
          if (sequenceRef.current !== sequence) {
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
          .then((paths) => applyPaths(paths.slice(0, FILE_SEARCH_RESULT_LIMIT)))
          .catch(() => {})
      }, FILE_SEARCH_DEBOUNCE_MS)
    },
    [operations, target]
  )

  return { nativeChatFilePaths, loadNativeChatFiles }
}
