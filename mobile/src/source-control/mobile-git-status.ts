import type {
  GitFileStatus,
  GitStagingArea,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../src/shared/git-status-types'

export type MobileGitFileStatus = GitFileStatus
export type MobileGitStagingArea = GitStagingArea
export type MobileGitStatusEntry = GitStatusEntry
export type MobileGitUpstreamStatus = GitUpstreamStatus
export type MobileGitStatusResult = GitStatusResult

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

function compareGitStatusEntries(a: MobileGitStatusEntry, b: MobileGitStatusEntry): number {
  return (
    getConflictSortRank(a) - getConflictSortRank(b) ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  )
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
  return AREA_ORDER.map((area) => ({
    area,
    title: AREA_TITLES[area],
    data: entries.filter((entry) => entry.area === area).sort(compareGitStatusEntries)
  })).filter((section) => section.data.length > 0)
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
