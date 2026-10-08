import type { ExecutionHostId } from '../../shared/execution-host'
import { hydratedAssignmentsForWorktree } from './host-editor-file-id-assignments'
import type { Tab, TabGroup } from '../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

/**
 * Editor tabs a host owns while no desktop window is the editor authority. They live in the same
 * workspace-session fields and formats the window writes, so a window that attaches later restores
 * them with the same ids and nothing to adopt.
 */
export type HostEditTabRecord = {
  /** Unified wrapper id; a legacy-format session has none, so the window's derived one. */
  tabId: string
  /** The persisted wrapper's own id, which group tab orders hold; null in a legacy-format session. */
  wrapperId: string | null
  /** The id the window's restored editor file gets. */
  fileId: string
  /** The id persisted wrappers carry for this row (`Tab.entityId`). */
  wrapperEntityId: string
  groupId: string | null
  file: PersistedOpenFile
  color: string | null
  isPinned: boolean
}

// Why: window hydration reads the whole session as unified only when both maps exist.
export function isUnifiedWorkspaceSession(session: WorkspaceSessionState): boolean {
  return Boolean(session.unifiedTabs && session.tabGroups)
}

export function listHostEditTabs(
  session: WorkspaceSessionState,
  worktreeId: string
): HostEditTabRecord[] {
  const assignments = hydratedAssignmentsForWorktree(session.openFilesByWorktree, worktreeId)
  if (assignments.length === 0) {
    return []
  }
  if (!isUnifiedWorkspaceSession(session)) {
    // Why: legacy hydration names each wrapper by path, then migrates it only when the path was the row's legacy id.
    return assignments.map(({ file, legacyId, id }) => ({
      tabId: legacyId === file.filePath ? id : file.filePath,
      wrapperId: null,
      fileId: id,
      wrapperEntityId: legacyId,
      groupId: null,
      file,
      color: null,
      isPinned: false
    }))
  }
  const wrappers = (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'editor'
  )
  return assignments.flatMap(({ file, legacyId, id }) =>
    wrappers
      .filter((wrapper) => (wrapper.entityId ?? wrapper.id) === legacyId)
      .map((wrapper) => ({
        // Why: window hydration migrates a wrapper named by its legacy file id to the restored id.
        tabId: wrapper.id === legacyId ? id : wrapper.id,
        wrapperId: wrapper.id,
        fileId: id,
        wrapperEntityId: legacyId,
        groupId: wrapper.groupId,
        file,
        color: wrapper.color ?? null,
        isPinned: wrapper.isPinned === true
      }))
  )
}

export function workspaceSessionHasHostEditRows(session: WorkspaceSessionState): boolean {
  return Object.values(session.openFilesByWorktree ?? {}).some((rows) => rows.length > 0)
}

export function listWorkspaceSessionEditRowWorktreeIds(session: WorkspaceSessionState): string[] {
  return Object.entries(session.openFilesByWorktree ?? {})
    .filter(([, rows]) => rows.length > 0)
    .map(([worktreeId]) => worktreeId)
}

export function pickTargetGroup(
  session: WorkspaceSessionState,
  worktreeId: string
): TabGroup | undefined {
  const groups = session.tabGroups?.[worktreeId] ?? []
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  return groups.find((group) => group.id === activeGroupId) ?? groups[0]
}

function pushRecent(recent: readonly string[] | undefined, tabId: string): string[] {
  return [...(recent ?? []).filter((id) => id !== tabId), tabId]
}

export type HostEditTabOpenResult = {
  session: WorkspaceSessionState
  record: HostEditTabRecord
  created: boolean
}

/** Adds (or reuses) an edit tab for `filePath` in one consistent session mutation. */
export function openHostEditTab(
  session: WorkspaceSessionState,
  args: {
    worktreeId: string
    filePath: string
    relativePath: string
    language: string
    executionHostId: ExecutionHostId
    activate: boolean
    now: number
    newId: () => string
  }
): HostEditTabOpenResult {
  const { worktreeId } = args
  const existing = listHostEditTabs(session, worktreeId).filter(
    (record) => record.file.filePath === args.filePath && !record.file.runtimeEnvironmentId
  )
  if (existing.length > 0) {
    const targetGroupId = pickTargetGroup(session, worktreeId)?.id
    const record = existing.find((candidate) => candidate.groupId === targetGroupId) ?? existing[0]!
    const kept = keepHostEditTab(session, worktreeId, record)
    return {
      session: args.activate ? activateHostEditTab(kept, worktreeId, record) : kept,
      record,
      created: false
    }
  }
  const sameOwnerRow = (session.openFilesByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.filePath === args.filePath && !candidate.runtimeEnvironmentId
  )
  // Why: a unified session can hold a row whose wrapper the window dropped; give it one instead of a duplicate row.
  const row: PersistedOpenFile = sameOwnerRow ?? {
    filePath: args.filePath,
    relativePath: args.relativePath,
    worktreeId,
    language: args.language
  }
  let next: WorkspaceSessionState = sameOwnerRow
    ? session
    : {
        ...session,
        openFilesByWorktree: {
          ...session.openFilesByWorktree,
          [worktreeId]: [...(session.openFilesByWorktree?.[worktreeId] ?? []), row]
        }
      }
  const addedRow = listHostEditTabs(
    { ...next, unifiedTabs: undefined, tabGroups: undefined },
    worktreeId
  ).find((record) => record.file === row)
  if (!addedRow) {
    throw new Error('editor_file_conflict')
  }
  if (isUnifiedWorkspaceSession(next)) {
    next = addUnifiedEditorWrapper(next, worktreeId, addedRow.wrapperEntityId, args)
  }
  const record = listHostEditTabs(next, worktreeId).find((candidate) => candidate.file === row)
  if (!record) {
    throw new Error('editor_file_conflict')
  }
  return {
    session: args.activate ? activateHostEditTab(next, worktreeId, record) : next,
    record,
    created: true
  }
}

/** An explicit open keeps a preview tab, as a window's open does, so a restore cannot replace it. */
function keepHostEditTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  record: HostEditTabRecord
): WorkspaceSessionState {
  const wrappers = session.unifiedTabs?.[worktreeId]
  const previewWrapper = wrappers?.some(
    (tab) => tab.isPreview && tab.contentType === 'editor' && tab.id === record.wrapperId
  )
  if (!record.file.isPreview && !previewWrapper) {
    return session
  }
  return {
    ...session,
    openFilesByWorktree: {
      ...session.openFilesByWorktree,
      [worktreeId]: (session.openFilesByWorktree?.[worktreeId] ?? []).map((row) => {
        if (row !== record.file) {
          return row
        }
        const { isPreview: _isPreview, ...kept } = row
        return kept
      })
    },
    ...(wrappers && previewWrapper
      ? {
          unifiedTabs: {
            ...session.unifiedTabs,
            [worktreeId]: wrappers.map((tab) =>
              tab.id === record.wrapperId ? { ...tab, isPreview: false } : tab
            )
          }
        }
      : {})
  }
}

function addUnifiedEditorWrapper(
  session: WorkspaceSessionState,
  worktreeId: string,
  entityId: string,
  args: {
    relativePath: string
    executionHostId: ExecutionHostId
    now: number
    newId: () => string
  }
): WorkspaceSessionState {
  const tabs = session.unifiedTabs?.[worktreeId] ?? []
  let groups = session.tabGroups?.[worktreeId] ?? []
  let group = pickTargetGroup(session, worktreeId)
  let layouts = session.tabGroupLayouts
  if (!group) {
    group = { id: args.newId(), worktreeId, activeTabId: null, tabOrder: [] }
    groups = [group]
    layouts = { ...layouts, [worktreeId]: { type: 'leaf', groupId: group.id } }
  }
  // Why: the window appends an unpinned, unanchored tab to the deduped order and renumbers every
  // sibling, so a gap left by an earlier close cannot hand two wrappers one sortOrder.
  const wrapperId = args.newId()
  const tabOrder = [...new Set(group.tabOrder.filter((id) => id !== wrapperId)), wrapperId]
  const sortOrderById = new Map(tabOrder.map((id, index) => [id, index]))
  const wrapper: Tab = {
    id: wrapperId,
    entityId,
    groupId: group.id,
    worktreeId,
    executionHostId: args.executionHostId,
    contentType: 'editor',
    label: args.relativePath,
    customLabel: null,
    color: null,
    sortOrder: tabOrder.length - 1,
    createdAt: args.now
  }
  const targetGroupId = group.id
  const renumbered = tabs.map((tab) => {
    const sortOrder = sortOrderById.get(tab.id)
    return sortOrder === undefined || sortOrder === tab.sortOrder ? tab : { ...tab, sortOrder }
  })
  return {
    ...session,
    unifiedTabs: { ...session.unifiedTabs, [worktreeId]: [...renumbered, wrapper] },
    tabGroups: {
      ...session.tabGroups,
      [worktreeId]: groups.map((candidate) =>
        candidate.id === targetGroupId ? { ...candidate, tabOrder } : candidate
      )
    },
    ...(layouts ? { tabGroupLayouts: layouts } : {})
  }
}

/** Makes `record` the worktree's focused editor tab, as a window focus would persist it. */
export function activateHostEditTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  record: Pick<HostEditTabRecord, 'tabId' | 'fileId' | 'groupId'>
): WorkspaceSessionState {
  const next: WorkspaceSessionState = {
    ...session,
    activeFileIdByWorktree: { ...session.activeFileIdByWorktree, [worktreeId]: record.fileId },
    activeTabTypeByWorktree: { ...session.activeTabTypeByWorktree, [worktreeId]: 'editor' }
  }
  const groups = session.tabGroups?.[worktreeId]
  const group = groups?.find((candidate) => candidate.id === record.groupId)
  if (!isUnifiedWorkspaceSession(session) || !groups || !group) {
    return next
  }
  return {
    ...next,
    activeGroupIdByWorktree: { ...session.activeGroupIdByWorktree, [worktreeId]: group.id },
    tabGroups: {
      ...session.tabGroups,
      [worktreeId]: groups.map((candidate) =>
        candidate.id === group.id
          ? {
              ...candidate,
              activeTabId: record.tabId,
              recentTabIds: pushRecent(candidate.recentTabIds, record.tabId)
            }
          : candidate
      )
    }
  }
}
