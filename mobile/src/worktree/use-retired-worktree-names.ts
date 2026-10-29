import { useEffect, useState } from 'react'
import {
  readRetiredNameRegistryForRepo,
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry,
  type RetiredNamesLoad
} from '../../../src/shared/worktree/retired-name-cache'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'
import type { RpcClient } from '../transport/rpc-client'
import { retiredWorktreeNamesRead } from './worktree-catalog-operations'

export function buildRetiredWorktreeNamesRefreshKey(
  existingWorktreePaths: readonly string[] | undefined
): string {
  return [...(existingWorktreePaths ?? [])].sort().join('\0')
}

// worktree.ps has no retired names; fetch only this repo while its create sheet is open.
// Change refreshKey on every catalog mutation; shared retired-name-cache rules keep failure behavior aligned with desktop.
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
    void retiredWorktreeNamesRead
      .request(client, { repo: `id:${activeRepoId}` })
      .then((reply) => {
        const names = retiredWorktreeNamesRead.interpret(reply)
        // Refusal intentionally settles as an empty registry; transport rejection preserves the previous names.
        settle(
          readRetiredNameRegistryForRepo(names.accepted ? names.value : undefined, activeRepoId)
        )
      })
      .catch(() => settle(null))
    return () => {
      cancelled = true
    }
  }, [activeRepoId, client, refreshKey])

  return selectRetiredNameRegistry(loaded, activeRepoId)
}
