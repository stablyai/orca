import type { MobileGitStagingArea } from './mobile-git-status'

export type MobileReviewRouteArea = MobileGitStagingArea | 'branch'

export type MobileReviewRouteTarget = {
  hostId: string
  worktreeId: string
  worktreeName: string
  filePath: string
  /** Scrolls to this new-side line, e.g. a review thread's "Open in diff". */
  line?: number
} & ({ area: MobileReviewRouteArea } | { area: 'commit'; commitOid: string })

export function buildMobileReviewFileRoute(target: MobileReviewRouteTarget): string {
  const params = new URLSearchParams()
  params.set('file', target.filePath)
  params.set('area', target.area)
  if (target.area === 'commit') {
    params.set('commit', target.commitOid)
  }
  if (target.line !== undefined) {
    params.set('line', String(target.line))
  }
  if (target.worktreeName) {
    params.set('name', target.worktreeName)
  }
  return `/h/${encodeURIComponent(target.hostId)}/review/${encodeURIComponent(
    target.worktreeId
  )}?${params.toString()}`
}
