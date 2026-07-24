import type {
  PersistedMobileClientTabSelection,
  PersistedMobileClientTabSelections
} from '../../shared/types'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MOBILE_TAB_SELECTION_MAX_CLIENTS = 64
export const MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT = 512
export const MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE = 128
export const MOBILE_TAB_SELECTION_ID_MAX_BYTES = 4 * 1024
export const MOBILE_TAB_SELECTION_MAX_BYTES_PER_SELECTION = 64 * 1024
export const MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT = 256 * 1024

export function isMobileTabSelectionIdRetainable(value: string): boolean {
  return !measureUtf8ByteLength(value, {
    stopAfterBytes: MOBILE_TAB_SELECTION_ID_MAX_BYTES
  }).exceededLimit
}

function mobileTabSelectionStringBytes(value: string | null): number {
  return value ? measureUtf8ByteLength(value).byteLength : 0
}

export function mobileTabSelectionRetainedBytes(
  worktreeId: string,
  selection: PersistedMobileClientTabSelection
): number {
  let bytes =
    mobileTabSelectionStringBytes(worktreeId) +
    mobileTabSelectionStringBytes(selection.activeTabId) +
    mobileTabSelectionStringBytes(selection.activeGroupId)
  for (const [groupId, tabId] of Object.entries(selection.activeTabIdByGroupId)) {
    bytes += mobileTabSelectionStringBytes(groupId) + mobileTabSelectionStringBytes(tabId)
  }
  return bytes
}

function newestOwnEntries(
  record: Record<string, unknown>,
  maxEntries: number,
  acceptKey: (key: string) => boolean = () => true
): [string, unknown][] {
  const entries: [string, unknown][] = []
  let nextReplacementIndex = 0
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue
    }
    if (!acceptKey(key)) {
      continue
    }
    const entry: [string, unknown] = [key, record[key]]
    if (entries.length < maxEntries) {
      entries.push(entry)
    } else {
      entries[nextReplacementIndex] = entry
      nextReplacementIndex = (nextReplacementIndex + 1) % maxEntries
    }
  }
  return nextReplacementIndex === 0
    ? entries
    : [...entries.slice(nextReplacementIndex), ...entries.slice(0, nextReplacementIndex)]
}

export function boundMobileClientTabSelectionGroups(
  selection: PersistedMobileClientTabSelection
): PersistedMobileClientTabSelection {
  const activeTabId =
    selection.activeTabId && isMobileTabSelectionIdRetainable(selection.activeTabId)
      ? selection.activeTabId
      : null
  const activeGroupId =
    selection.activeGroupId && isMobileTabSelectionIdRetainable(selection.activeGroupId)
      ? selection.activeGroupId
      : null
  let retainedBytes =
    mobileTabSelectionStringBytes(activeTabId) + mobileTabSelectionStringBytes(activeGroupId)
  const retainedGroups: [string, string][] = []
  const candidates = newestOwnEntries(
    selection.activeTabIdByGroupId,
    MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE,
    isMobileTabSelectionIdRetainable
  ).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && isMobileTabSelectionIdRetainable(entry[1])
  )
  for (let index = candidates.length - 1; index >= 0; index--) {
    const entry = candidates[index]!
    const entryBytes =
      mobileTabSelectionStringBytes(entry[0]) + mobileTabSelectionStringBytes(entry[1])
    if (retainedBytes + entryBytes > MOBILE_TAB_SELECTION_MAX_BYTES_PER_SELECTION) {
      break
    }
    retainedBytes += entryBytes
    retainedGroups.push(entry)
  }
  return {
    ...selection,
    activeTabId,
    activeGroupId,
    activeTabIdByGroupId: Object.fromEntries(retainedGroups.toReversed())
  }
}

function normalizeClientSessionTabSelection(
  raw: unknown
): PersistedMobileClientTabSelection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const candidate = raw as Partial<PersistedMobileClientTabSelection>
  const activeTabId =
    typeof candidate.activeTabId === 'string' &&
    isMobileTabSelectionIdRetainable(candidate.activeTabId)
      ? candidate.activeTabId
      : null
  const activeGroupId =
    typeof candidate.activeGroupId === 'string' &&
    isMobileTabSelectionIdRetainable(candidate.activeGroupId)
      ? candidate.activeGroupId
      : null
  const activeTabIdByGroupId: Record<string, string> = {}
  if (
    typeof candidate.activeTabIdByGroupId === 'object' &&
    candidate.activeTabIdByGroupId &&
    !Array.isArray(candidate.activeTabIdByGroupId)
  ) {
    for (const [groupId, tabId] of newestOwnEntries(
      candidate.activeTabIdByGroupId as Record<string, unknown>,
      MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE,
      isMobileTabSelectionIdRetainable
    )) {
      if (typeof tabId === 'string' && isMobileTabSelectionIdRetainable(tabId)) {
        activeTabIdByGroupId[groupId] = tabId
      }
    }
  }
  if (!activeTabId && !activeGroupId && Object.keys(activeTabIdByGroupId).length === 0) {
    return null
  }
  return boundMobileClientTabSelectionGroups({ activeTabId, activeGroupId, activeTabIdByGroupId })
}

// Why: this state comes off disk (and, for remote runtimes, another machine); a bad payload must degrade to "no selection", not throw.
export function normalizePersistedMobileClientTabSelections(
  raw: unknown
): PersistedMobileClientTabSelections {
  const normalized: PersistedMobileClientTabSelections = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return normalized
  }
  for (const [clientNavigationId, selectionsByWorktree] of newestOwnEntries(
    raw as Record<string, unknown>,
    MOBILE_TAB_SELECTION_MAX_CLIENTS,
    isMobileTabSelectionIdRetainable
  )) {
    if (
      typeof selectionsByWorktree !== 'object' ||
      selectionsByWorktree === null ||
      Array.isArray(selectionsByWorktree)
    ) {
      continue
    }
    const entries = new Map<string, PersistedMobileClientTabSelection>()
    let retainedBytes = 0
    for (const [worktreeId, selection] of newestOwnEntries(
      selectionsByWorktree as Record<string, unknown>,
      MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT,
      isMobileTabSelectionIdRetainable
    )) {
      const normalizedSelection = normalizeClientSessionTabSelection(selection)
      if (normalizedSelection) {
        entries.set(worktreeId, normalizedSelection)
        retainedBytes += mobileTabSelectionRetainedBytes(worktreeId, normalizedSelection)
        while (retainedBytes > MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT) {
          const oldest = entries.entries().next()
          if (oldest.done) {
            break
          }
          entries.delete(oldest.value[0])
          retainedBytes -= mobileTabSelectionRetainedBytes(oldest.value[0], oldest.value[1])
        }
      }
    }
    if (entries.size > 0) {
      normalized[clientNavigationId] = Object.fromEntries(entries)
    }
  }
  return normalized
}
