import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { rankSuggestions } from './mobile-native-chat-autocomplete'

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_RESULT_LIMIT = 16
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20
export const MOBILE_NATIVE_CHAT_LEGACY_FILE_MAX_PATHS = 50_000
export const MOBILE_NATIVE_CHAT_LEGACY_FILE_MAX_RETAINED_BYTES = 8 * 1024 * 1024
const FILE_SEARCH_RESULT_MAX_RETAINED_BYTES = 256 * 1024

export function retainMobileNativeChatFilePaths(
  result: unknown,
  maxPaths: number,
  maxRetainedBytes: number
): string[] {
  const files = (result as { files?: Array<{ relativePath?: string }> }).files ?? []
  const paths: string[] = []
  let retainedBytes = 0
  for (const file of files) {
    const path = file.relativePath
    if (typeof path !== 'string' || path.length === 0) {
      continue
    }
    const nextBytes = retainedBytes + path.length * 2 + 64
    if (paths.length >= maxPaths || nextBytes > maxRetainedBytes) {
      break
    }
    paths.push(path)
    retainedBytes = nextBytes
  }
  return paths
}

/** Debounces current-host path searches, bounds the mobile result/cache, and
 *  falls back to the legacy one-time full list when paired to an older host. */
export function useMobileNativeChatFileSearch(args: {
  client: RpcClient | null
  worktreeId: string
}): { nativeChatFilePaths: string[]; loadNativeChatFiles: (query: string) => void } {
  const { client, worktreeId } = args
  const [nativeChatFilePaths, setNativeChatFilePaths] = useState<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequenceRef = useRef(0)
  const generationRef = useRef(0)
  const queryCacheRef = useRef(new Map<string, string[]>())
  const legacyPathsRef = useRef<string[] | null>(null)
  const legacyLoadRef = useRef<Promise<string[] | null> | null>(null)
  const searchSupportedRef = useRef<boolean | null>(null)

  useEffect(() => {
    sequenceRef.current++
    generationRef.current++
    queryCacheRef.current.clear()
    legacyPathsRef.current = null
    legacyLoadRef.current = null
    searchSupportedRef.current = null
    setNativeChatFilePaths([])
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [client, worktreeId])

  const loadNativeChatFiles = useCallback(
    (query: string) => {
      if (!client) {
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
      const generation = generationRef.current
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
        const loadLegacyPaths = async (): Promise<void> => {
          if (!legacyPathsRef.current) {
            if (!legacyLoadRef.current) {
              const request = client
                .sendRequest('files.list', { worktree: `id:${worktreeId}` })
                .then((response) => {
                  if (!response.ok || generationRef.current !== generation) {
                    return null
                  }
                  const paths = retainMobileNativeChatFilePaths(
                    response.result,
                    MOBILE_NATIVE_CHAT_LEGACY_FILE_MAX_PATHS,
                    MOBILE_NATIVE_CHAT_LEGACY_FILE_MAX_RETAINED_BYTES
                  )
                  legacyPathsRef.current = paths
                  return paths
                })
                .finally(() => {
                  if (legacyLoadRef.current === request && !legacyPathsRef.current) {
                    legacyLoadRef.current = null
                  }
                })
              // Why: older hosts expose only the full inventory RPC; queries that
              // overlap its slow local/SSH read must share one request.
              legacyLoadRef.current = request
            }
            const paths = await legacyLoadRef.current
            if (!paths) {
              return
            }
          }
          const legacyPaths = legacyPathsRef.current
          if (legacyPaths) {
            applyPaths(rankSuggestions(legacyPaths, normalizedQuery, FILE_SEARCH_RESULT_LIMIT))
          }
        }
        void (async () => {
          if (searchSupportedRef.current === false) {
            await loadLegacyPaths()
            return
          }
          const response = await client.sendRequest('files.searchPaths', {
            worktree: `id:${worktreeId}`,
            query: normalizedQuery,
            limit: FILE_SEARCH_RESULT_LIMIT
          })
          if (response.ok) {
            searchSupportedRef.current = true
            applyPaths(
              retainMobileNativeChatFilePaths(
                response.result,
                FILE_SEARCH_RESULT_LIMIT,
                FILE_SEARCH_RESULT_MAX_RETAINED_BYTES
              )
            )
            return
          }
          if (response.error.code === 'method_not_found') {
            searchSupportedRef.current = false
            await loadLegacyPaths()
          }
        })().catch(() => {})
      }, FILE_SEARCH_DEBOUNCE_MS)
    },
    [client, worktreeId]
  )

  return { nativeChatFilePaths, loadNativeChatFiles }
}
