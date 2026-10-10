import type { Repo } from '../../../../shared/repo-types'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { gitExecFileAsync } from '../../../git/runner'
import type { SshGitProvider } from '../../../providers/ssh-git-provider'
import { isWorktreePathMissing } from '../../../worktree-removal-safety'

export async function isAlreadyRemovedWorktreePath(
  repo: Repo,
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    return isWorktreePathMissing(
      toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
      access.statPath
    )
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return false
  }
  return isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path))
}

export async function isLocalGitRepository(
  runtimeWorktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['status', '--short'], {
      cwd: runtimeWorktreePath,
      ...localWorktreeGitOptions
    })
    return true
  } catch (error) {
    return !gitStatusErrorMeansNotRepository(error)
  }
}

// Why: only Git's own "not a git repository" answer clears the recursive delete; a lost
// connection or refused command is unverifiable, so it counts as a repository.
export async function isRemoteGitRepository(
  provider: Pick<SshGitProvider, 'exec'> | null,
  worktreePath: string
): Promise<boolean> {
  if (!provider) {
    return true
  }
  try {
    // Why this flag: relays deny `--git-dir` in git.exec; this one exits 0 anywhere inside a repository.
    await provider.exec(['rev-parse', '--is-inside-work-tree'], worktreePath)
    return true
  } catch (error) {
    return !REMOTE_NOT_A_REPOSITORY_LINE.test(error instanceof Error ? error.message : '')
  }
}

// Why anchored: a substring match also accepts e.g. a dubious-ownership refusal whose repo path
// contains the phrase; the "up to mount point" variant is excluded since a repo may sit above it.
const REMOTE_NOT_A_REPOSITORY_LINE =
  /^fatal: not a git repository \(or any of the parent directories\): /m

export function gitStatusErrorMeansNotRepository(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : typeof error === 'string'
          ? error
          : ''
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : ''
  return /not a git repository/i.test(`${message}\n${stderr}`)
}
