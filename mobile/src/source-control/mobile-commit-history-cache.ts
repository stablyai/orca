import type { GitHistoryUpstreamVerdict } from '../../../src/shared/git-history-push-state'
import type { MobileGitHistoryResult } from './git-history-reply-schema'
import { BoundedMap } from '../../../src/shared/bounded-map'

export type MobileRememberedCommitHistory = {
  result: MobileGitHistoryResult
  upstream: GitHistoryUpstreamVerdict | null
}

// The commit page opens in the same page document as the timeline, so it reads the page the timeline showed.
const pages = new BoundedMap<string, MobileRememberedCommitHistory>({ maxEntries: 4 })

function treeKey(hostId: string, worktreeId: string): string {
  return `${hostId}\0${worktreeId}`
}

export function rememberMobileCommitHistory(
  hostId: string,
  worktreeId: string,
  result: MobileGitHistoryResult,
  upstream: GitHistoryUpstreamVerdict | null
): void {
  pages.set(treeKey(hostId, worktreeId), { result, upstream })
}

export function recallMobileCommitHistory(
  hostId: string,
  worktreeId: string
): MobileRememberedCommitHistory | null {
  return pages.get(treeKey(hostId, worktreeId)) ?? null
}
