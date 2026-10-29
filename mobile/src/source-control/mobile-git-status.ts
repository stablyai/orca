import { translate } from '../i18n/mobile-i18n'
import type { GitFileStatus, GitStagingArea } from '../../../src/shared/git-status-types'
import {
  buildSourceControlDisplaySections,
  groupSourceControlEntries,
  resolveSourceControlGroupOrder,
  type SourceControlDisplaySectionArea,
  type SourceControlDisplaySectionId
} from '../../../src/shared/source-control-section-order'
import { getUnstageAllPaths } from '../../../src/shared/source-control-discard-all-sequence'
import {
  canDiscardStatusEntry,
  canStageStatusEntry,
  canUnstageStatusEntry
} from '../../../src/shared/source-control-entry-actions'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'
import type { RpcResponse } from '../transport/types'
import type {
  MobileGitStatusEntry,
  MobileGitStatusHostPayload,
  MobileGitUpstreamStatus
} from './git-status-reply-schema'

export type MobileGitFileStatus = GitFileStatus
export type MobileGitStagingArea = GitStagingArea
export type { MobileGitStatusEntry, MobileGitUpstreamStatus }

export type MobileGitStatusResult = MobileGitStatusHostPayload

type KnownAreaEntry<TEntry extends MobileGitStatusEntry> = TEntry & { area: MobileGitStagingArea }

// Rows of an area this build does not know stay listed nowhere and get no row actions.
function hasKnownArea<TEntry extends MobileGitStatusEntry>(
  entry: TEntry
): entry is KnownAreaEntry<TEntry> {
  return entry.area !== undefined
}

export type MobileSourceControlSection<TEntry extends MobileGitStatusEntry = MobileGitStatusEntry> =
  {
    id: SourceControlDisplaySectionId
    area: SourceControlDisplaySectionArea
    title: string
    data: TEntry[]
  }

function sectionTitles(): Record<SourceControlDisplaySectionId, string> {
  return {
    conflicts: translate('sourceControl.gitStatus.conflicts', 'Conflicts'),
    unstaged: translate('sourceControl.gitStatus.changes', 'Changes'),
    staged: translate('sourceControl.gitStatus.stagedChanges', 'Staged Changes')
  }
}

// Desktop's sections: conflicts pinned on top, then the user's group order, sorted like desktop.
export function buildMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  entries: readonly TEntry[],
  groupOrder: SourceControlGroupOrder
): MobileSourceControlSection<TEntry>[] {
  const titles = sectionTitles()
  return buildSourceControlDisplaySections(
    groupSourceControlEntries(entries.filter(hasKnownArea)),
    resolveSourceControlGroupOrder(groupOrder)
  ).map((section) => ({
    id: section.id,
    area: section.area,
    title: titles[section.id],
    data: section.items
  }))
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
  return getUnstageAllPaths(entries.filter(hasKnownArea))
}

export function isMobileGitStageableEntry(entry: MobileGitStatusEntry): boolean {
  return hasKnownArea(entry) && canStageStatusEntry(entry)
}

export function isMobileGitDiscardableEntry(entry: MobileGitStatusEntry): boolean {
  return hasKnownArea(entry) && canDiscardStatusEntry(entry)
}

export function isMobileGitUnstageableEntry(entry: MobileGitStatusEntry): boolean {
  return hasKnownArea(entry) && canUnstageStatusEntry(entry)
}

// Unresolved conflicts cannot open as stable files; deletions can still show their pre-delete diff.
export function canOpenMobileGitStatusEntry(entry: MobileGitStatusEntry): boolean {
  return entry.conflictStatus !== 'unresolved'
}

// Preserve raw refusal code/message for capability fallback and retry routing before applying acceptance policy.
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
