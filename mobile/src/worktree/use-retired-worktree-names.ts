import { useEffect, useState } from 'react'
import {
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry,
  type RetiredNamesLoad
} from '../../../src/shared/worktree/retired-name-cache'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'

type ReadRetiredWorktreeNames = (repoId: string) => Promise<RetiredNameRegistry>

export function buildRetiredWorktreeNamesRefreshKey(
  existingWorktreePaths: readonly string[] | undefined
): string {
  return [...(existingWorktreePaths ?? [])].sort().join('\0')
}

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
  readRetiredNames: ReadRetiredWorktreeNames | null | undefined,
  repoId: string | null | undefined,
  refreshKey: unknown
): RetiredNameRegistry {
  const [loaded, setLoaded] = useState<RetiredNamesLoad | null>(null)
  const activeRepoId = readRetiredNames && repoId ? repoId : null

  useEffect(() => {
    if (!readRetiredNames || !activeRepoId) {
      setLoaded(null)
      return
    }
    let cancelled = false
    const settle = (registry: RetiredNameRegistry | null): void => {
      if (!cancelled) {
        setLoaded((previous) => retiredNamesAfterRefresh(previous, activeRepoId, registry))
      }
    }
    void readRetiredNames(activeRepoId)
      .then(settle)
      .catch(() => settle(null))
    return () => {
      cancelled = true
    }
  }, [activeRepoId, readRetiredNames, refreshKey])

  return selectRetiredNameRegistry(loaded, activeRepoId)
}
