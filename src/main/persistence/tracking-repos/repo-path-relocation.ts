import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  WORKTREE_ID_SEPARATOR
} from '../../../shared/worktree/id'

/** One workspace's path-derived id before and after the project moves. */
export type RepoWorkspaceIdentityMove = {
  readonly from: string
  readonly to: string
}

/**
 * The part of `filesystemPath` below the project root, or null when it is not at or inside it.
 *
 * Splits on the raw spelling but decides on the normalized one: a stored id can spell the root with
 * a different case or separator than the repo row does, so slicing by the repo path's length would
 * cut in the wrong place. Walking separator boundaries keeps the tail byte-exact as stored.
 */
function relocationTail(filesystemPath: string, rootKey: string): string | null {
  if (normalizeRuntimePathForComparison(filesystemPath) === rootKey) {
    return ''
  }
  for (let index = 0; index < filesystemPath.length; index += 1) {
    const character = filesystemPath[index]
    if (character !== '/' && character !== '\\') {
      continue
    }
    if (normalizeRuntimePathForComparison(filesystemPath.slice(0, index)) === rootKey) {
      return filesystemPath.slice(index)
    }
  }
  return null
}

/**
 * Worktree ids are `<repoId>::<path>` with an optional `::workspace:<uuid>` suffix, so a project's
 * registered path is baked into every workspace that lives at or inside its checkout. Moving the
 * project has to re-key them together; this plans the moves so the caller can apply them through the
 * same identity migration a worktree folder rename uses.
 *
 * Descendants move too, not just the checkout itself: `worktreeBasePath` is resolved relative to
 * `repo.path`, so a project configured with a relative base keeps its worktrees inside the directory
 * that is moving. A worktree under an absolute base lies outside the moved directory and is left
 * alone, which is correct — the move did not touch it.
 */
export function planRepoPathRelocation(
  state: PersistedState,
  repo: Pick<Repo, 'id' | 'path'>,
  newPath: string
): RepoWorkspaceIdentityMove[] {
  const oldKey = normalizeRuntimePathForComparison(repo.path)
  if (normalizeRuntimePathForComparison(newPath) === oldKey) {
    return []
  }
  const candidateIds = new Set([
    ...Object.keys(state.worktreeMeta ?? {}),
    ...Object.keys(state.worktreeLineageById ?? {})
  ])
  const moves: RepoWorkspaceIdentityMove[] = []
  for (const worktreeId of candidateIds) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed || parsed.repoId !== repo.id) {
      continue
    }
    const filesystemPath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    if (filesystemPath === undefined) {
      continue
    }
    const tail = relocationTail(filesystemPath, oldKey)
    if (tail === null) {
      continue
    }
    // The instance suffix is identity, not path; carry it across unchanged so sibling workspaces
    // stay distinct instead of collapsing onto one id.
    const instanceSuffix = parsed.worktreePath.slice(filesystemPath.length)
    const relocatedPath = `${newPath}${tail}`
    moves.push({
      from: worktreeId,
      to: `${repo.id}${WORKTREE_ID_SEPARATOR}${relocatedPath}${instanceSuffix}`
    })
  }
  return moves
}
