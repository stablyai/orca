import { useEffect, useState } from 'react'
import {
  readRetiredNameRegistryForRepo,
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry,
  type RetiredNamesLoad
} from '../../../src/shared/worktree/retired-name-cache'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'
import type { RpcClient } from '../transport/rpc-client'

/** Names already spent in a repo, including workspaces that have since been deleted.
 *
 *  Why a targeted request rather than the workspace catalog: the catalog is served by `worktree.ps`,
 *  which carries rows only. Retired names are needed just while the create sheet is open and only
 *  for one repo, so this asks for exactly that.
 *
 *  `refreshKey` must change on every workspace-list mutation. Caching rules live in
 *  `retired-name-cache` so this and the desktop hook cannot drift on what a failure means, and no
 *  loading state is reported because create is never gated on this fetch. */
export function useRetiredWorktreeNames(
  client: RpcClient | null | undefined,
  repoId: string | null | undefined,
  refreshKey: unknown
): RetiredNameRegistry {
  const [loaded, setLoaded] = useState<RetiredNamesLoad | null>(null)
  const activeRepoId = client && repoId ? repoId : null

  useEffect(() => {
    if (!client || !activeRepoId) {
      setLoaded(null)
      return
    }
    let cancelled = false
    const settle = (registry: RetiredNameRegistry | null): void => {
      if (!cancelled) {
        setLoaded((previous) => retiredNamesAfterRefresh(previous, activeRepoId, registry))
      }
    }
    void client
      .sendRequest('worktree.listRetiredNames', { repo: `id:${activeRepoId}` })
      .then((response) =>
        settle(
          readRetiredNameRegistryForRepo((response as { result?: unknown }).result, activeRepoId)
        )
      )
      .catch(() => settle(null))
    return () => {
      cancelled = true
    }
  }, [activeRepoId, client, refreshKey])

  return selectRetiredNameRegistry(loaded, activeRepoId)
}
