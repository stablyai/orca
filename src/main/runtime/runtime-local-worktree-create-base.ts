import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import type { WorktreeCreateBaseFallback } from '../../shared/worktree/create-types'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'

export type RuntimeLocalWorktreeCreateBase = {
  /** The base the add uses: the request's, or the local branch it fell back to. */
  baseBranch: string
  remoteTrackingBase: RemoteTrackingBase | null
  /** Refresh after naming without changing base: tracking ref if present, otherwise fetch origin for nonlocal bases. */
  deferredRefresh: 'tracking_ref' | 'origin' | null
  baseFallback?: WorktreeCreateBaseFallback
}

/** Resolve base/fallback before naming so branch reuse and conflict checks see the actual add base. */
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
    // Existing local refs are the requested base; no fetch or fallback needed.
    return { baseBranch, remoteTrackingBase: null, deferredRefresh: null }
  }
  const refresh = await args.timing.time('refresh_base_ref', () =>
    args.refreshRemoteTrackingBase(repoPath, remoteTrackingBase, options)
  )
  if (!refresh.ok) {
    // Try fresh remote first; offline, allow its named local branch only with an explicit fallback result.
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
