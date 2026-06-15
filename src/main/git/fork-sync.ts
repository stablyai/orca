import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import {
  syncForkDefaultBranch,
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult
} from '../../shared/git-fork-sync'
import { gitExecFileAsync } from './runner'

export async function gitSyncForkDefaultBranch(
  worktreePath: string,
  expectedUpstream?: GitForkSyncExpectedUpstream | null
): Promise<GitForkSyncResult> {
  try {
    return await syncForkDefaultBranch(
      (args) => gitExecFileAsync(args, { cwd: worktreePath, timeout: 60_000 }),
      { expectedUpstream }
    )
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}
