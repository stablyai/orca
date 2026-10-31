import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

type ProjectFilters = Partial<Pick<PersistedUIState, 'filterRepoIds' | 'agentsFilterRepoIds'>>

export function rewriteWslMoveProjectFilters(
  ui: ProjectFilters,
  scope: WslMoveRewriteScope
): ProjectFilters {
  const updates: ProjectFilters = {}
  for (const field of ['filterRepoIds', 'agentsFilterRepoIds'] as const) {
    const ids = ui[field] ?? []
    const present = new Set(ids)
    const moved = ids.flatMap((id) => {
      if (!id.startsWith('local\0') || !scope.repoInScope(id.slice(6))) {
        return []
      }
      const hostId = getRepoHostIdentityForParts(id.slice(6), scope.destinationHostId)
      if (present.has(hostId)) {
        return []
      }
      present.add(hostId)
      return [hostId]
    })
    if (moved.length) {
      updates[field] = [...ids, ...moved]
    }
  }
  return updates
}
