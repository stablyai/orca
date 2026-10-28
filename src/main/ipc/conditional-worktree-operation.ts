import {
  beginConditionalWorktreeUse,
  beginConditionalWorktreeGlobalUse
} from './conditional-worktree-removal-lease'

export function withConditionalWorktreeGlobalUse<T>(run: () => Promise<T>): Promise<T> {
  const release = beginConditionalWorktreeGlobalUse()
  try {
    return run().finally(release)
  } catch (error) {
    release()
    throw error
  }
}

type WorkspaceOperationTarget = { workspaceId: string; hostId: string }

export function withConditionalWorktreeUses<T>(
  targets: readonly WorkspaceOperationTarget[],
  run: () => Promise<T>
): Promise<T> {
  const releases: (() => void)[] = []
  const releaseAll = (): void => {
    for (const release of releases) {
      release()
    }
  }
  try {
    for (const target of targets) {
      releases.push(beginConditionalWorktreeUse(target.workspaceId, target.hostId))
    }
    return run().finally(releaseAll)
  } catch (error) {
    releaseAll()
    throw error
  }
}
