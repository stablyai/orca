import type { GitFileStatus, GitStagingArea } from '../../../src/shared/git-status-types'
import type { RpcResponse } from '../transport/types'
import type {
  MobileGitStatusEntry,
  MobileGitStatusHostPayload,
  MobileGitUpstreamStatus
} from './git-status-reply-schema'

export type MobileGitFileStatus = GitFileStatus
export type MobileGitStagingArea = GitStagingArea
export type { MobileGitStatusEntry, MobileGitUpstreamStatus }

// The shape mobile reads off `git.status`, which is the reply schema's output, not the desktop
// aggregate: every member mobile does not read is stripped rather than re-declared here.
export type MobileGitStatusResult = MobileGitStatusHostPayload

export type MobileSourceControlSection<TEntry extends MobileGitStatusEntry = MobileGitStatusEntry> =
  {
    area: MobileGitStagingArea
    title: string
    data: TEntry[]
  }

const AREA_ORDER: MobileGitStagingArea[] = ['unstaged', 'untracked', 'staged']

const AREA_TITLES: Record<MobileGitStagingArea, string> = {
  unstaged: 'Changes',
  untracked: 'Untracked Files',
  staged: 'Staged Changes'
}

export const MOBILE_GIT_STATUS_LABELS: Record<MobileGitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  copied: 'C'
}

function getConflictSortRank(entry: MobileGitStatusEntry): number {
  if (entry.conflictStatus === 'unresolved') {
    return 0
  }
  if (entry.conflictStatus === 'resolved_locally') {
    return 1
  }
  return 2
}

export function buildMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  entries: readonly TEntry[]
): MobileSourceControlSection<TEntry>[] {
  const sections = AREA_ORDER.map((area) => ({
    area,
    title: AREA_TITLES[area],
    data: entries.filter((entry) => entry.area === area)
  })).filter((section) => section.data.length > 0)
  if (sections.some((section) => section.data.length > 1)) {
    const collator = new Intl.Collator(undefined, { numeric: true })
    for (const section of sections) {
      section.data.sort(
        (a, b) =>
          getConflictSortRank(a) - getConflictSortRank(b) || collator.compare(a.path, b.path)
      )
    }
  }
  return sections
}

export function countStagedEntries(entries: readonly MobileGitStatusEntry[]): number {
  return entries.filter((entry) => entry.area === 'staged').length
}

export function countUnstagedEntries(entries: readonly MobileGitStatusEntry[]): number {
  return entries.filter((entry) => entry.area === 'unstaged' || entry.area === 'untracked').length
}

export function getStageablePaths(entries: readonly MobileGitStatusEntry[]): string[] {
  return entries.filter(isMobileGitStageableEntry).map((entry) => entry.path)
}

export function getUnstageablePaths(entries: readonly MobileGitStatusEntry[]): string[] {
  return entries.filter((entry) => entry.area === 'staged').map((entry) => entry.path)
}

export function isMobileGitStageableEntry(entry: MobileGitStatusEntry): boolean {
  return (
    (entry.area === 'unstaged' || entry.area === 'untracked') &&
    entry.conflictStatus !== 'unresolved'
  )
}

export function isMobileGitDiscardableEntry(entry: MobileGitStatusEntry): boolean {
  return entry.conflictStatus !== 'unresolved' && entry.conflictStatus !== 'resolved_locally'
}

// Why: unresolved conflicts are not a stable file to open. Deletions are —
// git.diff still returns the pre-delete side (text or image via modifiedDeleted).
export function canOpenMobileGitStatusEntry(entry: MobileGitStatusEntry): boolean {
  return entry.conflictStatus !== 'unresolved'
}

/**
 * The refusal behind a reply, or null when the host accepted it.
 *
 * Four source-control loads route on the refusal itself rather than on acceptance: two degrade to
 * a capability-missing screen, one retries a not-yet-visible selector, and one falls back to a
 * different method. No acceptance policy carries `code` and `message` through, so those call sites
 * read the refusal here — in one place, before they hand the reply to the operation's policy.
 */
export function readMobileGitRefusal(
  response: RpcResponse
): { code: string | undefined; message: string | undefined } | null {
  return response.ok ? null : { code: response.error?.code, message: response.error?.message }
}

export function isMobileGitUnavailableReply(response: RpcResponse): boolean {
  const refusal = readMobileGitRefusal(response)
  return refusal !== null && isMobileGitUnavailable(refusal.code, refusal.message)
}

export function isMobileGitUnavailable(code: string | undefined, message: string | undefined) {
  return (
    code === 'forbidden' ||
    code === 'method_not_found' ||
    message?.includes('not available to mobile clients') === true
  )
}

export function isMobileGitTransientRefreshError(
  code: string | undefined,
  message: string | undefined
) {
  const normalized = message?.trim().toLowerCase()
  return code === 'request_aborted' || normalized === 'aborting' || normalized === 'request_aborted'
}
