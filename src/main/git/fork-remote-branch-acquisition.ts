import type { GitPushTarget } from '../../shared/worktree/types'
import {
  withForkRemoteLock,
  acquireForkView,
  currentBranch,
  forkDestination,
  buildNarrowForkFetchRefspec,
  remoteHasOrcaProvenance,
  type ForkBranchOperation,
  type GitExecFn
} from './fork-remote-policy'

async function fetchForkBranchUnderLock(
  exec: GitExecFn,
  path: string,
  name: string,
  source: string,
  destination: string
): Promise<boolean> {
  const spec = `+${source}:${destination}`
  try {
    await exec(['fetch', '--no-tags', `--refmap=${spec}`, name, spec], path)
    return true
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : error instanceof Error
          ? error.message
          : ''
    if (
      stderr.trim() !== `fatal: couldn't find remote ref ${source}` &&
      stderr.trim() !== `fatal: could not find remote ref ${source}`
    ) {
      throw error
    }
    return false
  }
}
async function configureForkBranchUnderLock(
  exec: GitExecFn,
  path: string,
  branch: string,
  target: GitPushTarget,
  destination: string,
  absent: boolean,
  legacy = false
) {
  if (absent || legacy) {
    await exec(['config', `branch.${branch}.remote`, target.remoteName], path)
    await exec(['config', `branch.${branch}.merge`, `refs/heads/${target.branchName}`], path)
  } else {
    await exec(['branch', '--set-upstream-to', destination, branch], path)
  }
  const { stdout } = await exec(
    [
      'for-each-ref',
      '--format=%(refname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)',
      `refs/heads/${branch}`
    ],
    path
  )
  const actual = stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .find(([ref]) => ref === `refs/heads/${branch}`)
  if (
    !actual ||
    actual[1] !== destination ||
    actual[2] !== target.remoteName ||
    actual[3] !== `refs/heads/${target.branchName}`
  ) {
    throw new Error('Effective Git upstream differs from the requested fork branch.')
  }
}
export async function acquireForkBranchUnderLock(
  exec: GitExecFn,
  path: string,
  operation: ForkBranchOperation
): Promise<ForkBranchOperation> {
  const { target, source, destination, view, localBranch, branch, scope, added } = operation
  if (!destination) {
    await exec(
      [
        'fetch',
        target.remoteName,
        buildNarrowForkFetchRefspec(target.remoteName, target.branchName)
      ],
      path
    )
    return operation
  }
  const cached = view
    ? !added && view.refs.some((row) => row.ref === destination)
    : await exec(['rev-parse', '--verify', '--quiet', destination], path).then(
        () => true,
        () => false
      )
  const present =
    cached || (await fetchForkBranchUnderLock(exec, path, target.remoteName, source, destination))
  const fresh = view && !cached ? await acquireForkView(exec, path, scope, target.remoteUrl) : view
  if (fresh && view) {
    if (
      forkDestination(fresh, target) !== destination ||
      (localBranch &&
        ((branch ?? currentBranch(fresh)) !== localBranch ||
          (!branch && fresh.head !== view.head) ||
          fresh.refs.find((row) => row.ref === `refs/heads/${localBranch}`)?.oid !==
            view.refs.find((row) => row.ref === `refs/heads/${localBranch}`)?.oid))
    ) {
      throw new Error('Fork tracking changed while preparing the branch.')
    }
  }
  return { ...operation, present, view: fresh }
}

export async function configureForkCallerUnderLock(
  exec: GitExecFn,
  path: string,
  operation: ForkBranchOperation
): Promise<GitPushTarget> {
  const { target, destination, localBranch, present, view } = operation
  if (localBranch && destination) {
    if (view) {
      forkDestination(view, target)
    }
    await configureForkBranchUnderLock(
      exec,
      path,
      localBranch,
      target,
      destination,
      !present,
      view?.legacy.has(target.remoteName)
    )
  }
  const { remoteCreated: _ignored, ...selected } = target
  return target.remoteUrl
    ? { ...selected, remoteCreated: await remoteHasOrcaProvenance(exec, path, target.remoteName) }
    : selected
}
export async function fetchForkBranch(
  exec: GitExecFn,
  path: string,
  remote: string,
  branch: string,
  scope = '',
  url?: string
): Promise<boolean> {
  return withForkRemoteLock(
    exec,
    path,
    async () => {
      const view = await acquireForkView(exec, path, scope, url)
      const target = { remoteName: remote, branchName: branch, remoteUrl: url }
      return fetchForkBranchUnderLock(
        exec,
        path,
        remote,
        `refs/heads/${branch}`,
        forkDestination(view, target)
      )
    },
    scope
  )
}
