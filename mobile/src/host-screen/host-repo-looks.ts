import type { SectionRepo } from '../worktree/workspace-list-types'
import { sectionRepoColor } from '../worktree/workspace-filter-repos'
import { readMobileRepoIcon, type MobileHostRepoIcon } from './host-screen-reply-schema'

export type RepoLook = { color: string; icon: MobileHostRepoIcon | null }

/** Decoded once per catalog, so a row's props keep their identity across polls. */
export function buildRepoLookById(
  repoById: ReadonlyMap<string, SectionRepo>
): ReadonlyMap<string, RepoLook> {
  return new Map(
    [...repoById].map(([id, repo]) => [
      id,
      { color: sectionRepoColor(repo), icon: readMobileRepoIcon(repo.repoIcon) }
    ])
  )
}
