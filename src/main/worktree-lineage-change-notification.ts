import { getRepoIdFromWorktreeId } from '../shared/worktree/id'

export function notifyLineageRepos(
  notifyChanged: (repoId: string) => void,
  repoId: string,
  ...parentWorktreeIds: readonly (string | null | undefined)[]
): void {
  const repoIds = new Set([repoId])
  for (const id of parentWorktreeIds) {
    if (id) {
      repoIds.add(getRepoIdFromWorktreeId(id))
    }
  }
  for (const id of repoIds) {
    notifyChanged(id)
  }
}
