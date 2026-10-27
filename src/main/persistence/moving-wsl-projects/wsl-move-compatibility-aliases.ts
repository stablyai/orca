import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { createWslMoveStringNormalizer } from './wsl-move-canonical-form'
import type { WslMoveProjectionScope } from './wsl-move-state-projection'

/** Verify moved UNC IDs remain resolvable via priorWorktreeIds; projection normalization hides alias loss. */
export function findMissingWslMoveAliases(
  sourceWorktreeIds: readonly string[],
  destinationMeta: Readonly<Record<string, WorktreeMeta>>,
  scope: Pick<WslMoveProjectionScope, 'distro'>
): string[] {
  const normalize = createWslMoveStringNormalizer({ distro: scope.distro, hostAliases: [] })
  return sourceWorktreeIds.filter((sourceId) => {
    const destinationId = normalize(sourceId)
    return (
      destinationId !== sourceId &&
      !destinationMeta[destinationId]?.priorWorktreeIds?.includes(sourceId)
    )
  })
}
