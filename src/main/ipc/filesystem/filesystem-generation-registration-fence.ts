import { hasSameRepoRegistration } from '../../persistence/tracking-repos/repo-registration-identity'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import { resolveRegisteredWorktreePath } from '../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { getRepoForSourceControlAi } from './filesystem-source-control-ai-targets'

/** True while the repo registration, worktree path and git options a generation started with still hold. */
export function registeredGenerationTargetFence(
  store: Store,
  args: { repoId?: string; worktreePath: string; connectionId?: string },
  started: {
    registeredRepo: Repo | null | undefined
    worktreePath: string
    gitOptions: ReturnType<typeof getLocalGitOptionsForRegisteredWorktree>
  }
): () => Promise<boolean> {
  const startedGitOptions = JSON.stringify(started.gitOptions)
  return async () => {
    try {
      const latest = await getRepoForSourceControlAi(store, args)
      return (
        !!latest &&
        hasSameRepoRegistration(latest, started.registeredRepo) &&
        (await resolveRegisteredWorktreePath(args.worktreePath, store)) === started.worktreePath &&
        JSON.stringify(
          getLocalGitOptionsForRegisteredWorktree(store, args.worktreePath, started.worktreePath)
        ) === startedGitOptions
      )
    } catch {
      return false
    }
  }
}
