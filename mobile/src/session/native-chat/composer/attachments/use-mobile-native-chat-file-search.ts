import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../../../../query/generation-scoped-request-owner'
import {
  nativeChatFileInventoryRead,
  nativeChatFileSearchRead
} from '../../../../files/explorer/native-chat-file-search-operations'
import {
  getPreparedQuickOpenFiles,
  rankQuickOpenFiles
} from '../../../../../../src/shared/quick-open/quick-open-path-search'
import { withFolderPaths } from '../../../../../../src/shared/quick-open/quick-open-folder-paths'

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_RESULT_LIMIT = 16
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20

/** Ranks the paths with the folders holding them, as desktop's `@` does. */
function rankWithFolders(paths: readonly string[], query: string, limit: number): string[] {
  return rankQuickOpenFiles(query, getPreparedQuickOpenFiles(withFolderPaths(paths)), limit).map(
    (result) => result.path
  )
}

const NO_ANSWER: { query: string | null; paths: string[] } = { query: null, paths: [] }

/** The legacy inventory is the whole workspace, so its request carries no further parameters. */
type WorkspaceInventoryParameters = Readonly<Record<string, never>>
const WHOLE_WORKSPACE: WorkspaceInventoryParameters = {}

export function useMobileNativeChatFileSearch(args: {
  client: RpcClient | null
  worktreeId: string
  /** How many paths to rank; the `@` menu shows a few, the Files search a screenful. */
  limit?: number
}): {
  nativeChatFilePaths: string[]
  /** The normalized query the paths answer; null while a newer one is pending. */
  nativeChatFilesQuery: string | null
  loadNativeChatFiles: (query: string) => void
} {
  const { client, worktreeId, limit = FILE_SEARCH_RESULT_LIMIT } = args
  const [answer, setAnswer] = useState<{ query: string | null; paths: string[] }>(NO_ANSWER)
  const setNativeChatFilePaths = useCallback(
    (paths: string[], query: string | null = null) => setAnswer({ query, paths }),
    []
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequenceRef = useRef(0)
  const queryCacheRef = useRef(new Map<string, string[]>())
  const queryCacheGenerationRef = useRef<number | null>(null)
  const searchSupportedRef = useRef<boolean | null>(null)
  const inventory = useRef(
    new GenerationScopedRequestOwner<WorkspaceInventoryParameters, string[]>()
  ).current

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    sequenceRef.current++
    queryCacheRef.current.clear()
    queryCacheGenerationRef.current = null
    searchSupportedRef.current = null
    setNativeChatFilePaths([])
    return () => {
      // Unmount must retire the owner too: no future call remains to notice a changed scope.
      inventory.reset()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [client, inventory, worktreeId])

  const loadNativeChatFiles = useCallback(
    (query: string) => {
      if (!client) {
        return
      }
      const generation = client.getGeneration?.() ?? 0
      if (queryCacheGenerationRef.current !== generation) {
        queryCacheGenerationRef.current = generation
        queryCacheRef.current.clear()
        searchSupportedRef.current = null
        inventory.reset()
      }
      const normalizedQuery = query.trim().toLowerCase().slice(0, 256)
      const cached = queryCacheRef.current.get(normalizedQuery)
      if (cached) {
        // Cancel and stale pending debounce work before cached results display so late queries cannot overwrite them.
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        sequenceRef.current++
        setNativeChatFilePaths(cached, normalizedQuery)
        return
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      const sequence = ++sequenceRef.current
      setNativeChatFilePaths([])
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const isCurrentRequest = (): boolean =>
          mountedRef.current &&
          sequenceRef.current === sequence &&
          (client.getGeneration?.() ?? 0) === generation
        const applyPaths = (paths: string[]): void => {
          if (!isCurrentRequest()) {
            return
          }
          queryCacheRef.current.set(normalizedQuery, paths)
          while (queryCacheRef.current.size > FILE_SEARCH_QUERY_CACHE_LIMIT) {
            const oldest = queryCacheRef.current.keys().next().value
            if (oldest === undefined) {
              break
            }
            queryCacheRef.current.delete(oldest)
          }
          setNativeChatFilePaths(paths, normalizedQuery)
        }
        // A failed read answers the query with nothing, uncached, so a caller waiting on it stops waiting.
        const answerNothing = (): void => {
          if (isCurrentRequest()) {
            setNativeChatFilePaths([], normalizedQuery)
          }
        }
        const loadLegacyPaths = async (): Promise<void> => {
          if (!mountedRef.current) {
            return
          }
          // Scope inventory to host/workspace/logical authority, not physical reconnect; capture once so cutover cannot split an attempt’s identity.
          const inventoryScope: RequestScope = [client, worktreeId, generation]
          const held = inventory.read(inventoryScope, WHOLE_WORKSPACE)
          if (held) {
            applyPaths(rankWithFolders(held, normalizedQuery, limit))
            return
          }
          // Share overlapping legacy full-inventory reads, especially across slow SSH.
          const loaded = await inventory.load(inventoryScope, WHOLE_WORKSPACE, async () => {
            const response = await nativeChatFileInventoryRead.request(client, {
              worktree: `id:${worktreeId}`
            })
            const accepted = nativeChatFileInventoryRead.interpret(response)
            return accepted.accepted ? accepted.value : null
          })
          if (
            !loaded ||
            inventory.commit(loaded.lease, loaded.value) !== 'committed' ||
            !isCurrentRequest()
          ) {
            return
          }
          applyPaths(rankWithFolders(loaded.value, normalizedQuery, limit))
        }
        void (async () => {
          if (!isCurrentRequest()) {
            return
          }
          if (searchSupportedRef.current === false) {
            await loadLegacyPaths()
            return
          }
          const response = await nativeChatFileSearchRead.request(client, {
            worktree: `id:${worktreeId}`,
            query: normalizedQuery,
            limit
          })
          const accepted = nativeChatFileSearchRead.interpret(response)
          if (!isCurrentRequest()) {
            return
          }
          if (accepted.accepted) {
            searchSupportedRef.current = true
            applyPaths(rankWithFolders(accepted.value, normalizedQuery, limit))
            return
          }
          // Inspect method_not_found before policy interpretation to choose legacy inventory fallback.
          if (!response.ok && response.error.code === 'method_not_found') {
            searchSupportedRef.current = false
            await loadLegacyPaths()
            return
          }
          answerNothing()
        })().catch(answerNothing)
      }, FILE_SEARCH_DEBOUNCE_MS)
    },
    [client, inventory, limit, setNativeChatFilePaths, worktreeId]
  )

  return {
    nativeChatFilePaths: answer.paths,
    nativeChatFilesQuery: answer.query,
    loadNativeChatFiles
  }
}
