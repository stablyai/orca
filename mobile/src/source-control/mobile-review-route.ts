import { FullGitObjectId } from '../../../src/shared/rpc-contract/git-params'
import type { MobileGitStagingArea } from './mobile-git-status'

export type MobileReviewRouteArea = MobileGitStagingArea | 'branch' | 'commit'

export type MobileReviewRouteTarget = {
  hostId: string
  worktreeId: string
  worktreeName: string
  filePath: string
  area: MobileReviewRouteArea
  // Required for the commit area: whose files the review steps through.
  commitId?: string
}

export function buildMobileReviewFileRoute(target: MobileReviewRouteTarget): string {
  const params = new URLSearchParams()
  // Open the tapped file but keep scope all so next/previous can traverse the full changed-file queue.
  params.set('scope', 'all')
  params.set('file', target.filePath)
  params.set('area', target.area)
  if (target.commitId) {
    params.set('commit', target.commitId)
  }
  if (target.worktreeName) {
    params.set('name', target.worktreeName)
  }
  return `/h/${encodeURIComponent(target.hostId)}/review/${encodeURIComponent(
    target.worktreeId
  )}?${params.toString()}`
}

export function buildMobileCommitDetailRoute(target: {
  hostId: string
  worktreeId: string
  worktreeName: string
  commitId: string
}): string {
  const params = new URLSearchParams({ sha: target.commitId })
  if (target.worktreeName) {
    params.set('name', target.worktreeName)
  }
  return `/h/${encodeURIComponent(target.hostId)}/commit/${encodeURIComponent(
    target.worktreeId
  )}?${params.toString()}`
}

// Route params are user-controllable links; only a full object id may reach RPCs or the Explain prompt.
export function readCommitRouteSha(value: string): string | null {
  return FullGitObjectId.safeParse(value).success ? value : null
}
