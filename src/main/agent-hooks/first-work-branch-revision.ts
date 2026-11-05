import { hasSameRepoRegistration } from '../persistence/tracking-repos/repo-registration-identity'
import type { Repo } from '../../shared/repo-types'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { isWslMoveRepoBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { probeBranchUpstream, type GitExec } from '../git/branch-rename'
import { createTextGenerationParamsFence } from '../text-generation/text-generation-settings-fence'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'

export async function captureFirstWorkBranchRevision(cwd: string, exec: GitExec, branch: string) {
  const file = await exec(['rev-parse', '--git-path', 'HEAD'])
    .then((result) => result.stdout.trim())
    .catch(() => '')
  const revision = () => {
    try {
      if (!file) {
        return undefined
      }
      const stat = statSync(resolve(cwd, file), { bigint: true })
      return `${stat.ino}:${stat.mtimeNs}:${stat.size}`
    } catch {
      return undefined
    }
  }
  const original = revision()
  return {
    canFailover: original !== undefined,
    current: () => revision() === original,
    validate: async () => {
      try {
        return (
          revision() === original &&
          (await exec(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() === branch &&
          (await probeBranchUpstream(exec)).outcome === 'no-upstream'
        )
      } catch {
        // A removed worktree makes git throw; that is a stale target, not a rejected request.
        return false
      }
    }
  }
}

export function captureFirstWorkBranchOwner(
  worktreeId: string,
  repo: Repo,
  deps: FirstWorkBranchRenameDeps,
  branchCurrent: () => boolean
) {
  const settingsCurrent = createTextGenerationParamsFence(
    () => deps.getSettings(),
    getCommitMessageModelDiscoveryHostKey(null),
    'branchName',
    repo
  )
  const displayName = deps.getCurrentDisplayName(worktreeId)
  const revision = deps.getRenameOwnerRevision?.(worktreeId)
  return () =>
    settingsCurrent() &&
    hasSameRepoRegistration(deps.getRepo(repo.id), repo) &&
    !isWslMoveRepoBlocked(repo) &&
    deps.getCurrentDisplayName(worktreeId) === displayName &&
    deps.getRenameOwnerRevision?.(worktreeId) === revision &&
    branchCurrent()
}
