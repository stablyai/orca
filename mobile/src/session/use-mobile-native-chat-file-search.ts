import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../transport/generation-scoped-request-owner'
import {
  nativeChatFileInventoryRead,
  nativeChatFileSearchRead
} from './mobile-session-read-operations'
import { rankSuggestions } from './mobile-native-chat-autocomplete'

function extractPaths(files: unknown): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return ((files as { relativePath?: string }[] | undefined) ?? [])
    .map((file) => file.relativePath ?? '')
    .filter((path): path is string => path.length > 0)
}

const FILE_SEARCH_DEBOUNCE_MS = 120
const FILE_SEARCH_RESULT_LIMIT = 16
const FILE_SEARCH_QUERY_CACHE_LIMIT = 20

/** The legacy inventory is the whole workspace, so its request carries no further parameters. */
type WorkspaceInventoryParameters = Readonly<Record<string, never>>
const WHOLE_WORKSPACE: WorkspaceInventoryParameters = {}

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
  const queryCacheRef = useRef(new Map<string, string[]>())
  const searchSupportedRef = useRef<boolean | null>(null)
  const inventory = useRef(
    new GenerationScopedRequestOwner<WorkspaceInventoryParameters, string[]>()
  ).current

  useEffect(() => {
    sequenceRef.current++
    queryCacheRef.current.clear()
    searchSupportedRef.current = null
    setNativeChatFilePaths([])
    return () => {
      // The owner retires itself the moment a call arrives under a scope it has not seen; this is
      // the teardown path, where no such call is coming.
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
        const loadLegacyPaths = async (): Promise<void> => {
          // What retires the inventory: this host, this workspace, this logical authority. A
          // reconnect to the same host leaves the files on disk alone, so the physical session
          // epoch is deliberately not in it. Read once, so a cutover between the two calls below
          // cannot put one attempt in two scopes.
          const inventoryScope: RequestScope = [client, worktreeId, client.getGeneration?.() ?? 0]
          const held = inventory.read(inventoryScope, WHOLE_WORKSPACE)
          if (held) {
            applyPaths(rankSuggestions(held, normalizedQuery, FILE_SEARCH_RESULT_LIMIT))
            return
          }
          // Why: older hosts expose only the full inventory RPC; queries that
          // overlap its slow local/SSH read must share one request.
          const loaded = await inventory.load(inventoryScope, WHOLE_WORKSPACE, async () => {
            const response = await nativeChatFileInventoryRead.request(client, {
              worktree: `id:${worktreeId}`
            })
            const accepted = nativeChatFileInventoryRead.interpret(response)
            return accepted.accepted ? extractPaths(accepted.value) : null
          })
          if (!loaded || inventory.commit(loaded.lease, loaded.value) !== 'committed') {
            return
          }
          applyPaths(rankSuggestions(loaded.value, normalizedQuery, FILE_SEARCH_RESULT_LIMIT))
        }
        void (async () => {
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
          if (accepted.accepted) {
            searchSupportedRef.current = true
            applyPaths(extractPaths(accepted.value))
            return
          }
          // Why the raw refusal: `method_not_found` is what makes the composer fall back to the
          // full inventory, and no acceptance policy carries a code.
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
