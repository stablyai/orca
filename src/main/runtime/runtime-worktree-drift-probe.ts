import type { Repo } from '../../shared/repo-types'
import { getBaseRefDefault, getRecentDriftSubjects, getRemoteDrift } from '../git/repo'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { Store } from '../persistence'
import type { RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const DRIFT_PROBE_SUBJECT_LIMIT = 5

export async function probeRuntimeWorktreeDrift(args: {
  selector: string
  store: Store | null
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options: { wslDistro?: string }
  ) => Promise<RemoteTrackingBase | null>
  fetchRemote: (repoPath: string, remote: string, options: { wslDistro?: string }) => Promise<void>
}): Promise<{ base: string; behind: number; recentSubjects: string[] } | null> {
  const worktree = await args.resolveWorktree(args.selector)
  if (!args.store) {
    return null
  }
  const repo = args.store.getRepos().find((candidate: Repo) => candidate.id === worktree.repoId)
  if (!repo || repo.connectionId) {
    return null
  }
  const gitExecOptions = getLocalProjectGitExecOptions(args.store, repo)
  const worktreeGitOptions = getLocalProjectWorktreeGitOptions(args.store, repo)
  const meta = args.store.getWorktreeMeta(worktree.id)
  const base =
    meta?.baseRef ||
    meta?.sparseBaseRef ||
    repo.worktreeBaseRef ||
    (await getBaseRefDefault(repo.path, worktreeGitOptions))
  if (!base) {
    return null
  }
  const remoteTrackingBase = await args.resolveRemoteTrackingBase(
    repo.path,
    base,
    worktreeGitOptions
  )
  if (!remoteTrackingBase) {
    return null
  }
  await args.fetchRemote(repo.path, remoteTrackingBase.remote, worktreeGitOptions)
  const drift = await getRemoteDrift(worktree.path, 'HEAD', base, gitExecOptions)
  if (!drift) {
    return null
  }
  const recentSubjects =
    drift.behind > 0
      ? await getRecentDriftSubjects(
          worktree.path,
          'HEAD',
          base,
          DRIFT_PROBE_SUBJECT_LIMIT,
          gitExecOptions
        )
      : []
  return { base, behind: drift.behind, recentSubjects }
}
