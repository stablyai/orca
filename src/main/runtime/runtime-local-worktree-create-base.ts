import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import type { WorktreeCreateBaseFallback } from '../../shared/worktree/create-types'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'

export type RuntimeLocalWorktreeCreateBase = {
  /** The base the add uses: the request's, or the local branch it fell back to. */
  baseBranch: string
  remoteTrackingBase: RemoteTrackingBase | null
  /**
   * Best-effort refresh the git create runs after naming, since it cannot change the base: the
   * existing tracking ref, or `fetch origin` for a plain base that is not local yet.
   */
  deferredRefresh: 'tracking_ref' | 'origin' | null
  baseFallback?: WorktreeCreateBaseFallback
}

/**
 * Decides the base before naming, because branch reuse and conflict checks must see the base the
 * add will use, including the local fallback.
 */
export async function resolveRuntimeLocalWorktreeCreateBase(args: {
  repoPath: string
  baseBranch: string
  localWorktreeGitOptions: LocalGitExecOptions
  allowLocalBaseFallback: boolean
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options?: LocalGitExecOptions
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
  timing: WorktreeCreateTimingRecorder
}): Promise<RuntimeLocalWorktreeCreateBase> {
  const { repoPath, baseBranch, localWorktreeGitOptions: options } = args
  const remoteTrackingBase = await args.resolveRemoteTrackingBase(repoPath, baseBranch, options)
  if (!remoteTrackingBase) {
    const hasBase = await hasLocalWorktreeBaseRef(repoPath, baseBranch, options)
    return { baseBranch, remoteTrackingBase: null, deferredRefresh: hasBase ? null : 'origin' }
  }
  const [hadRemoteRef, hasNamedLocalBaseRef] = await Promise.all([
    args.hasRemoteTrackingRef(repoPath, remoteTrackingBase, options),
    hasLocalWorktreeBaseRef(repoPath, baseBranch, options)
  ])
  if (hadRemoteRef) {
    return { baseBranch, remoteTrackingBase, deferredRefresh: 'tracking_ref' }
  }
  if (hasNamedLocalBaseRef) {
    // Why: a local ref of the requested name (often a plain local branch like `team/feature`) is
    // the base asked for, so there is nothing to fetch and no fallback to report.
    return { baseBranch, remoteTrackingBase: null, deferredRefresh: null }
  }
  const refresh = await args.timing.time('refresh_base_ref', () =>
    args.refreshRemoteTrackingBase(repoPath, remoteTrackingBase, options)
  )
  if (!refresh.ok) {
    // Why: fetch first so an online create still gets the fresh remote base; only when that fails
    // (offline) does the local branch the remote names beat failing the create, and the result says so.
    if (
      args.allowLocalBaseFallback &&
      (await hasLocalWorktreeBaseRef(repoPath, remoteTrackingBase.branch, options))
    ) {
      return {
        baseBranch: remoteTrackingBase.branch,
        remoteTrackingBase: null,
        deferredRefresh: null,
        baseFallback: { requestedRef: remoteTrackingBase.base, localRef: remoteTrackingBase.branch }
      }
    }
    throw new Error(
      `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
    )
  }
  if (!(await args.hasRemoteTrackingRef(repoPath, remoteTrackingBase, options))) {
    throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
  }
  return { baseBranch, remoteTrackingBase, deferredRefresh: null }
}
