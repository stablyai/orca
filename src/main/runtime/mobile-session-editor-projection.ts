/**
 * Editor tabs a headless host persisted, such as those a converted SSH host's migration carried
 * in. No renderer publishes them there, so the host projects and retires them itself; a paired
 * desktop mirrors what it lists.
 */
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { Tab } from '../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import {
  editorTabNamesFile,
  sameEditorFile
} from '../../shared/workspace-layout/workspace-layout-editor-tab-file'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

export type HeadlessEditorTab = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

function editorWorkspace(session: WorkspaceSessionState, worktreeId: string) {
  return {
    worktreeId,
    tabs: session.unifiedTabs?.[worktreeId] ?? [],
    editorFiles: session.openFilesByWorktree?.[worktreeId]
  }
}

function editorUnifiedTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  file: PersistedOpenFile
): Tab | undefined {
  const workspace = editorWorkspace(session, worktreeId)
  return workspace.tabs.find(
    (tab) => tab.contentType === 'editor' && editorTabNamesFile(workspace, tab.entityId, file)
  )
}

/** A file's phone tab id: its unified tab's, else its path. */
function listedTabId(unifiedTab: Tab | undefined, file: PersistedOpenFile): string {
  return unifiedTab?.id ?? file.filePath
}

function editorTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  file: PersistedOpenFile
): HeadlessEditorTab {
  const unifiedTab = editorUnifiedTab(session, worktreeId, file)
  const activeFileId = session.activeFileIdByWorktree?.[worktreeId]
  const common = {
    id: listedTabId(unifiedTab, file),
    title: file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File',
    filePath: file.filePath,
    relativePath: file.relativePath,
    isDirty: file.dirtyDraftContent !== undefined,
    isActive:
      session.activeTabTypeByWorktree?.[worktreeId] === 'editor' &&
      !!activeFileId &&
      editorTabNamesFile(editorWorkspace(session, worktreeId), activeFileId, file),
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true
  }
  if (file.language === 'markdown') {
    return {
      ...common,
      type: 'markdown',
      language: 'markdown',
      mode: 'edit',
      sourceFileId: file.filePath,
      sourceFilePath: file.filePath,
      sourceRelativePath: file.relativePath,
      documentVersion: `file:${file.filePath}`
    }
  }
  return { ...common, type: 'file', language: file.language, mode: 'edit' }
}

export const HEADLESS_EDITOR_UNSAVED_DRAFT_ERROR = 'editor_tab_has_unsaved_draft'

export function buildHeadlessMobileSessionEditorTabs(
  worktreeId: string,
  session: WorkspaceSessionState
): HeadlessEditorTab[] {
  return (session.openFilesByWorktree?.[worktreeId] ?? []).map((file) =>
    editorTab(session, worktreeId, file)
  )
}

/** The record the phone's tab names: two owners can hold one path, so by the id it was listed under. */
function listedFile(
  files: readonly PersistedOpenFile[],
  session: WorkspaceSessionState,
  worktreeId: string,
  tab: Pick<HeadlessEditorTab, 'id' | 'filePath'>
): PersistedOpenFile | undefined {
  const samePath = files.filter((candidate) => candidate.filePath === tab.filePath)
  // Why no fallback for two: a stale id would retire the other owner's record.
  return samePath.length < 2
    ? samePath[0]
    : samePath.find(
        (candidate) =>
          listedTabId(editorUnifiedTab(session, worktreeId, candidate), candidate) === tab.id
      )
}

/** The session without one persisted editor tab, or null when it holds no such tab. */
export function retireHeadlessEditorTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  tab: Pick<HeadlessEditorTab, 'id' | 'filePath'>,
  force = false
): WorkspaceSessionState | null {
  const files = session.openFilesByWorktree?.[worktreeId] ?? []
  const file = ORCA_LAYOUT_OWNER_IS_MAIN
    ? listedFile(files, session, worktreeId, tab)
    : files.find((candidate) => candidate.filePath === tab.filePath)
  if (!file) {
    return null
  }
  // No window here can prompt to save, and the draft lives nowhere else.
  if (file.dirtyDraftContent !== undefined && !force) {
    throw new Error(HEADLESS_EDITOR_UNSAVED_DRAFT_ERROR)
  }
  const unifiedTabId = editorUnifiedTab(session, worktreeId, file)?.id ?? tab.id
  const withoutTab = (ids: readonly string[] | undefined): string[] | undefined =>
    ids?.filter((id) => id !== unifiedTabId)
  const groups = (session.tabGroups?.[worktreeId] ?? []).map((group) => ({
    ...group,
    activeTabId: group.activeTabId === unifiedTabId ? null : group.activeTabId,
    tabOrder: withoutTab(group.tabOrder) ?? [],
    ...(group.recentTabIds ? { recentTabIds: withoutTab(group.recentTabIds) } : {})
  }))
  const activeFileId = session.activeFileIdByWorktree?.[worktreeId]
  const wasActiveFile =
    !!activeFileId && editorTabNamesFile(editorWorkspace(session, worktreeId), activeFileId, file)
  return {
    ...session,
    openFilesByWorktree: {
      ...session.openFilesByWorktree,
      [worktreeId]: files.filter((candidate) => !sameEditorFile(candidate, file))
    },
    unifiedTabs: {
      ...session.unifiedTabs,
      [worktreeId]: (session.unifiedTabs?.[worktreeId] ?? []).filter(
        (candidate) => candidate.id !== unifiedTabId
      )
    },
    ...(session.tabGroups ? { tabGroups: { ...session.tabGroups, [worktreeId]: groups } } : {}),
    ...(wasActiveFile
      ? { activeFileIdByWorktree: { ...session.activeFileIdByWorktree, [worktreeId]: null } }
      : {}),
    ...(session.activeTabIdByWorktree?.[worktreeId] === unifiedTabId
      ? { activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [worktreeId]: null } }
      : {})
  }
}

export type HeadlessEditorRetirementHost = {
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options: { force: true }
  ): unknown
  notifyMobileSessionTabsChanged(worktreeId: string): void
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot): void
}

/** Retires a listed editor from the host's own session and republishes; false when not found. */
export function retireHeadlessMobileSessionEditorTab(
  host: HeadlessEditorRetirementHost,
  worktreeId: string,
  tab: { id: string; type: string; filePath?: string },
  force = false
): boolean {
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  const next =
    session && (tab.type === 'markdown' || tab.type === 'file') && tab.filePath
      ? retireHeadlessEditorTab(session, worktreeId, { id: tab.id, filePath: tab.filePath }, force)
      : null
  if (!next) {
    return false
  }
  host.setWorkspaceSessionForWorktree(worktreeId, next)
  // Why drop it first: a rebuild that finds no tabs left keeps the old snapshot.
  const existing = host.mobileSessionTabsByWorktree.get(worktreeId)
  if (existing) {
    host.storeMobileSessionSnapshot(worktreeId, {
      ...existing,
      snapshotVersion: existing.snapshotVersion + 1,
      activeTabId: existing.activeTabId === tab.id ? null : existing.activeTabId,
      tabGroups: existing.tabGroups?.map((group) => ({
        ...group,
        activeTabId: group.activeTabId === tab.id ? null : group.activeTabId,
        tabOrder: group.tabOrder.filter((id) => id !== tab.id)
      })),
      tabs: existing.tabs.filter((candidate) => candidate.id !== tab.id)
    })
  }
  host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
  host.notifyMobileSessionTabsChanged(worktreeId)
  return true
}
