import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SessionUnitSelection } from '../../../shared/session-unit-reader'

const catalogs = new WeakMap<PersistedState['repos'], Map<string, PersistedState['repos']>>()

/** Catalog replacement is an explicit rebuild boundary, never part of an owner edit. */
export function sessionNormalizationRepos(
  repos: PersistedState['repos'],
  scope: SessionUnitSelection
): PersistedState['repos'] {
  let byId = catalogs.get(repos)
  if (!byId) {
    byId = new Map()
    for (const repo of repos) {
      const entries = byId.get(repo.id) ?? []
      entries.push(repo)
      byId.set(repo.id, entries)
    }
    catalogs.set(repos, byId)
  }
  return [...(scope.get('terminalTopologyRevisionByRepoId') ?? [])].flatMap(
    (id) => byId.get(id) ?? []
  )
}
