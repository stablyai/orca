import { useState } from 'react'
import type { SectionRepo } from '../../worktree/workspace-list/workspace-list-types'
import { sectionRepoColor } from '../../worktree/repositories/workspace-filter-repos'
import { readMobileRepoIcon, type MobileHostRepoIcon } from '../host-screen-reply-schema'

export type RepoLook = { color: string; icon: MobileHostRepoIcon | null }

function buildRepoLookById(
  repoById: ReadonlyMap<string, SectionRepo>
): ReadonlyMap<string, RepoLook> {
  return new Map(
    [...repoById].map(([id, repo]) => [
      id,
      { color: sectionRepoColor(repo), icon: readMobileRepoIcon(repo.repoIcon) }
    ])
  )
}

// The fields the icon renders from; an unchanged data URL is the same string instance, so this stays cheap.
function sameIcon(a: MobileHostRepoIcon | null, b: MobileHostRepoIcon | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  if (a.type === 'lucide') {
    return b.type === 'lucide' && a.name === b.name
  }
  if (a.type === 'emoji') {
    return b.type === 'emoji' && a.emoji === b.emoji
  }
  return b.type === 'image' && a.src === b.src && a.label === b.label
}

function sameLooks(a: ReadonlyMap<string, RepoLook>, b: ReadonlyMap<string, RepoLook>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [id, look] of b) {
    const held = a.get(id)
    if (!held || held.color !== look.color || !sameIcon(held.icon, look.icon)) {
      return false
    }
  }
  return true
}

/**
 * Each repo's colour and icon, keeping the same map until one of them changes. The repo map is rebuilt on
 * every row poll (it adds stand-ins for rows' unknown repos), and a new look map would redraw every row and header.
 */
export function useRepoLookById(
  repoById: ReadonlyMap<string, SectionRepo>
): ReadonlyMap<string, RepoLook> {
  const [looks, setLooks] = useState(() => buildRepoLookById(repoById))
  const [lookedAt, setLookedAt] = useState(repoById)
  if (lookedAt !== repoById) {
    setLookedAt(repoById)
    const next = buildRepoLookById(repoById)
    if (!sameLooks(looks, next)) {
      setLooks(next)
    }
  }
  return looks
}
