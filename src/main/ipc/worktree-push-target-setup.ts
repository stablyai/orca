import { getGitCurrentBranchName } from '../../shared/git-current-branch'
import type { GitPushTarget } from '../../shared/worktree/types'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import {
  selectForkBranchUnderLock,
  acquireForkBranchUnderLock,
  configureForkCallerUnderLock,
  withForkRemoteLock,
  sameForkRepository
} from '../git/fork-remote-refspec'

export async function findRemoteForUrl(
  exec: GitRemoteExec,
  path: string,
  url: string
): Promise<string | null> {
  const remotes = parseGitRemoteFetchUrls((await exec(['remote', '-v'], path)).stdout)
  return [...remotes].find(([, candidate]) => sameForkRepository(candidate, url))?.[0] ?? null
}
export async function remoteAlreadyMatchesUrl(
  exec: GitRemoteExec,
  path: string,
  name: string,
  url: string
): Promise<boolean> {
  return exec(['remote', 'get-url', name], path).then(
    ({ stdout }) => sameForkRepository(stdout.trim(), url),
    () => false
  )
}
export async function resolveCheckedOutBranchName(
  exec: GitRemoteExec,
  path: string
): Promise<string | null> {
  return getGitCurrentBranchName((args) => exec(args, path))
}
export async function ensureUniqueRemoteName(
  exec: GitRemoteExec,
  path: string,
  preferred: string
): Promise<string> {
  return uniqueRemoteName(
    new Set((await exec(['remote'], path)).stdout.trim().split(/\r?\n/)),
    preferred
  )
}
function uniqueRemoteName(names: ReadonlySet<string>, preferred: string): string {
  if (!names.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!names.has(`${preferred}-${suffix}`)) {
      return `${preferred}-${suffix}`
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

async function prepareCallerPushTarget(
  exec: GitRemoteExec,
  path: string,
  target: GitPushTarget,
  scope: string,
  configureBranch: boolean,
  preferredName: string,
  branch?: string
): Promise<GitPushTarget> {
  return withForkRemoteLock(
    exec,
    path,
    async () => {
      const selected = await selectForkBranchUnderLock(
        exec,
        path,
        target,
        scope,
        configureBranch,
        preferredName,
        branch
      )
      const acquired = await acquireForkBranchUnderLock(exec, path, selected)
      return configureForkCallerUnderLock(exec, path, acquired)
    },
    scope
  )
}

export async function prepareWorktreePushTargetWithExec(
  exec: GitRemoteExec,
  path: string,
  target: GitPushTarget,
  scope = '',
  configureBranch = false,
  preferredName = target.remoteName
): Promise<GitPushTarget> {
  return prepareCallerPushTarget(exec, path, target, scope, configureBranch, preferredName)
}

export async function restoreUpstreamAfterMaterialize(
  exec: GitRemoteExec,
  path: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  const branch = await resolveCheckedOutBranchName(exec, path)
  return branch && target.remoteUrl
    ? configureCreatedWorktreePushTargetWithExec(exec, path, branch, target)
    : target
}
export async function configureCreatedWorktreePushTargetWithExec(
  exec: GitRemoteExec,
  path: string,
  branch: string,
  target: GitPushTarget,
  scope = ''
): Promise<GitPushTarget> {
  return prepareCallerPushTarget(exec, path, target, scope, true, target.remoteName, branch)
}
