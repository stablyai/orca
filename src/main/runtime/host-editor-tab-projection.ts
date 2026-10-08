import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { detectLanguage } from '../../shared/language-detect'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import {
  projectMobileSessionFileTab,
  projectMobileSessionMarkdownTab,
  type MobileSessionEditorFileFacts
} from '../../shared/mobile-session-editor-tab-projection'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { isUnifiedWorkspaceSession, listHostEditTabs } from './host-editor-session-model'
import { pickActiveTabId, topLevelTabId, type HostEditorFocus } from './host-editor-tab-focus'
import {
  placeEditorsInSnapshotGroups,
  projectPersistedTabGroups
} from './host-editor-tab-group-placement'
import type { HostDiffTabRecord } from './host-editor-tab-state'
import { isSafeMobileRelativePath } from './runtime-file-command-host'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

export type HostEditorMobileTab = {
  tab: RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab
  groupId: string | null
  fileId: string
  /** The id persisted group orders hold for this tab; null for a live-only diff or a legacy row. */
  persistedTabId: string | null
}

function isEditorSnapshotTab(
  tab: RuntimeMobileSessionSnapshotTab
): tab is RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab {
  return tab.type === 'markdown' || tab.type === 'file'
}

/** Whether a phone may reach a row's file: on this workspace's host, under its root. */
export function isHostEditRowInsideWorkspace(
  file: PersistedOpenFile,
  workspaceRoot: string | null
): boolean {
  if (file.externalSshTargetId?.trim() || !isSafeMobileRelativePath(file.relativePath)) {
    return false
  }
  return (
    workspaceRoot === null ||
    // Why the shared key: the window decides "inside" case-insensitively on Windows roots.
    normalizeRuntimePathForComparison(
      joinWorktreeRelativePath(workspaceRoot, file.relativePath)
    ) === normalizeRuntimePathForComparison(file.filePath)
  )
}

/**
 * Editor tabs a host with no window publishes for one worktree: persisted edits, then live diffs.
 * Rows naming files outside the workspace stay in the session but are not listed, since no phone
 * read of them is allowed.
 */
export function buildHostEditorMobileTabs(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  diffs: readonly HostDiffTabRecord[],
  workspaceRoot: string | null
): HostEditorMobileTab[] {
  const tabs: HostEditorMobileTab[] = []
  for (const record of session ? listHostEditTabs(session, worktreeId) : []) {
    if (!isHostEditRowInsideWorkspace(record.file, workspaceRoot)) {
      continue
    }
    const draft = record.file.readOnly === true ? undefined : record.file.dirtyDraftContent
    const facts: MobileSessionEditorFileFacts = {
      id: record.fileId,
      filePath: record.file.filePath,
      relativePath: record.file.relativePath,
      // Why re-detect: windows re-detect on restore; stored ids can predate newer extensions.
      language: detectLanguage(record.file.relativePath || record.file.filePath),
      mode: 'edit',
      isDirty: draft !== undefined
    }
    const presentation = {
      tabId: record.tabId,
      isActive: false,
      color: record.color,
      isPinned: record.isPinned
    }
    const tab =
      projectMobileSessionMarkdownTab(
        presentation,
        facts,
        facts,
        draft === undefined ? undefined : hashMarkdownContent(draft)
      ) ?? projectMobileSessionFileTab(presentation, facts)
    tabs.push({
      tab,
      groupId: record.groupId,
      fileId: record.fileId,
      persistedTabId: record.wrapperId
    })
  }
  for (const diff of diffs) {
    tabs.push({
      tab: projectMobileSessionFileTab(
        { tabId: diff.tabId, isActive: false },
        {
          id: diff.fileId,
          filePath: diff.filePath,
          relativePath: diff.relativePath,
          language: diff.language,
          mode: 'diff',
          isDirty: false,
          diffSource: diff.diffSource
        }
      ),
      groupId: diff.groupId,
      fileId: diff.fileId,
      persistedTabId: null
    })
  }
  return tabs
}

/**
 * Replaces a headless snapshot's editor tabs with the host's current editor tabs, placing each in
 * its persisted group and position. Re-derived on every hydrate, so a closed tab cannot come back.
 */
export function overlayHostEditorTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus = {}
): RuntimeMobileSessionTabsSnapshot {
  const baseTabs = snapshot.tabs.filter((tab) => !isEditorSnapshotTab(tab))
  const previousEditorIds = new Set(snapshot.tabs.filter(isEditorSnapshotTab).map((tab) => tab.id))
  if (editors.length === 0 && previousEditorIds.size === 0) {
    // Why: a worktree with no editor tabs keeps the terminal-only projection untouched.
    return snapshot
  }
  const projected =
    session && isUnifiedWorkspaceSession(session) && editors.length > 0
      ? projectPersistedTabGroups(snapshot, baseTabs, editors, session)
      : null
  let groups =
    projected?.groups ??
    placeEditorsInSnapshotGroups(snapshot, baseTabs, editors, session, previousEditorIds)

  const candidateTabs = [...baseTabs, ...editors.map((editor) => editor.tab)]
  const activeTabId = pickActiveTabId(snapshot, candidateTabs, editors, session, focus, groups)
  const nextTabs = candidateTabs.map((tab) =>
    isEditorSnapshotTab(tab) || tab.id === activeTabId || tab.isActive
      ? { ...tab, isActive: tab.id === activeTabId }
      : tab
  )
  const activeTab = nextTabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTopLevelId = activeTab ? topLevelTabId(activeTab) : null
  const activeGroup = activeTopLevelId
    ? groups.find((group) => group.tabOrder.includes(activeTopLevelId))
    : undefined
  groups = groups.map((group) => {
    if (group === activeGroup && activeTopLevelId) {
      return { ...group, activeTabId: activeTopLevelId }
    }
    return group.activeTabId ? group : { ...group, activeTabId: group.tabOrder[0] ?? null }
  })
  const { tabGroupLayout: previousLayout, ...rest } = snapshot
  const tabGroupLayout = projected ? projected.layout : previousLayout
  return {
    ...rest,
    ...(tabGroupLayout ? { tabGroupLayout } : {}),
    activeGroupId:
      activeGroup?.id ??
      (groups.some((group) => group.id === snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : (groups[0]?.id ?? null)),
    activeTabId: activeTab?.id ?? null,
    activeTabType: activeTab?.type ?? null,
    tabGroups: groups,
    tabs: nextTabs
  }
}
