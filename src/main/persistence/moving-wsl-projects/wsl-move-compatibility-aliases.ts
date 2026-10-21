import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { createWslMoveStringNormalizer } from './wsl-move-canonical-form'
import type { WslMoveProjectionScope } from './wsl-move-state-projection'

/**
 * Source worktree ids the destination cannot resolve any more: every moved UNC id must stay in
 * its Linux row's `priorWorktreeIds` (item 14), so a straggler that still names it finds the row.
 * The projection treats that alias as noise, so this checks it on its own.
 */
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
