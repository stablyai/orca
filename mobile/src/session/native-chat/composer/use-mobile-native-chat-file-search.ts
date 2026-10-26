import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../../transport/rpc-client'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../../../transport/generation-scoped-request-owner'
import {
  nativeChatFileInventoryRead,
  nativeChatFileSearchRead
} from '../../mobile-session-read-operations'
import { rankSuggestions } from '../../mobile-native-chat-autocomplete'

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_RESULT_LIMIT = 16
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20

/** The legacy inventory is the whole workspace, so its request carries no further parameters. */
type WorkspaceInventoryParameters = Readonly<Record<string, never>>
const WHOLE_WORKSPACE: WorkspaceInventoryParameters = {}

export function useMobileNativeChatFileSearch(args: {
  client: RpcClient | null
  worktreeId: string
}): { nativeChatFilePaths: string[]; loadNativeChatFiles: (query: string) => void } {
  const { client, worktreeId } = args
  const [nativeChatFilePaths, setNativeChatFilePaths] = useState<string[]>([])
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
            const oldest = queryCacheRef.current.keys().next().value as string | undefined
            if (!oldest) {
              break
            }
            queryCacheRef.current.delete(oldest)
          }
          setNativeChatFilePaths(paths)
        }
        const loadLegacyPaths = async (): Promise<void> => {
          if (!mountedRef.current) {
            return
          }
          // Scope inventory to host/workspace/logical authority, not physical reconnect; capture once so cutover cannot split an attempt’s identity.
          const inventoryScope: RequestScope = [client, worktreeId, generation]
          const held = inventory.read(inventoryScope, WHOLE_WORKSPACE)
          if (held) {
            applyPaths(rankSuggestions(held, normalizedQuery, FILE_SEARCH_RESULT_LIMIT))
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
          if (!loaded || inventory.commit(loaded.lease, loaded.value) !== 'committed') {
            return
          }
          applyPaths(rankSuggestions(loaded.value, normalizedQuery, FILE_SEARCH_RESULT_LIMIT))
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
            limit: FILE_SEARCH_RESULT_LIMIT
          })
          const accepted = nativeChatFileSearchRead.interpret(response)
          if (!isCurrentRequest()) {
            return
          }
          if (accepted.accepted) {
            searchSupportedRef.current = true
            applyPaths(accepted.value)
            return
          }
          // Inspect method_not_found before policy interpretation to choose legacy inventory fallback.
          if (!response.ok && response.error.code === 'method_not_found') {
            searchSupportedRef.current = false
            await loadLegacyPaths()
          }
        })().catch(() => {})
      }, FILE_SEARCH_DEBOUNCE_MS)
    },
    [client, inventory, worktreeId]
  )

  return { nativeChatFilePaths, loadNativeChatFiles }
}
