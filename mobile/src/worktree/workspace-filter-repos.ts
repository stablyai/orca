import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { repoColor } from './repo-color'
import type { SectionRepo, Worktree } from './workspace-list-types'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
}

/** A repo's badge colour, else the colour its name hashes to. */
export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor' | 'displayName'>): string {
  return (typeof repo.badgeColor === 'string' && repo.badgeColor) || repoColor(repo.displayName)
}

/** A stand-in repo per repo the rows name, first row's name winning. */
function rowStandInRepos(worktrees: readonly Worktree[]): SectionRepo[] {
  const repos = new Map<string, SectionRepo>()
  for (const w of worktrees) {
    if (!repos.has(w.repoId)) {
      repos.set(w.repoId, {
        id: w.repoId,
        displayName: w.repo || 'Unknown',
        // Why: labels key on host + path, so a shared '' would let one stand-in rename another.
        path: w.repoId,
        executionHostId: w.hostId
      })
    }
  }
  return [...repos.values()]
}

/**
 * The repos the filter lists, as the desktop's project filter lists them: every catalog repo by
 * id, each host's separately. Before any catalog answers, the repos the rows name.
 */
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[]
): WorkspaceSectionRepo[] {
  const repos = filterCatalogRepos.length > 0 ? filterCatalogRepos : rowStandInRepos(worktrees)
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}
