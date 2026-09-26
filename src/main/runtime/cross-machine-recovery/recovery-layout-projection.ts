import { isAbsolute, relative } from 'node:path'
import type {
  RecoveryBrowser,
  RecoveryEditor,
  RecoveryLayout,
  RecoveryTab,
  RecoveryTabGroup,
  RecoveryTerminalLayout
} from '../../../shared/cross-machine-recovery-descriptor'
import { sanitizeTerminalTabForRecovery } from '../../../shared/cross-machine-recovery-session-projection'
import { findOpenFileByEditorId, withEditorBackingPath } from '../../../shared/owned-editor-file-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

function projectTerminalLayout(snapshot: TerminalLayoutSnapshot): RecoveryTerminalLayout {
  return {
    root: snapshot.root,
    activeLeafId: snapshot.activeLeafId,
    expandedLeafId: snapshot.expandedLeafId,
    ...(snapshot.chatLeafId !== undefined ? { chatLeafId: snapshot.chatLeafId } : {}),
    ...(snapshot.titlesByLeafId !== undefined ? { titlesByLeafId: snapshot.titlesByLeafId } : {})
  }
}

function relativeWithin(root: string, target: string): string | null {
  const path = relative(root, target)
  return path.startsWith('..') || isAbsolute(path) ? null : path
}

function projectBrowsers(session: WorkspaceSessionState, worktreeId: string): RecoveryBrowser[] {
  return (session.browserTabsByWorktree?.[worktreeId] ?? []).map((browser) => ({
    id: browser.id,
    ...(browser.label !== undefined ? { label: browser.label } : {}),
    activePageId: browser.activePageId ?? null,
    pages: (session.browserPagesByWorkspace?.[browser.id] ?? []).map((page) => ({
      id: page.id,
      url: page.url,
      ...(page.title ? { title: page.title } : {})
    }))
  }))
}

/**
 * Projects one worktree's slice of the host-authoritative local session partition, dropping
 * PTY incarnations, scrollback, drafts and host-only launch overrides.
 */
export function projectRecoveryLayout(
  session: WorkspaceSessionState,
  worktreeId: string,
  worktreePath: string
): RecoveryLayout {
  const terminalTabs = session.tabsByWorktree[worktreeId] ?? []
  const openFiles = session.openFilesByWorktree?.[worktreeId] ?? []
  const activeFileId = session.activeFileIdByWorktree?.[worktreeId] ?? null
  const terminalLayouts: Record<string, RecoveryTerminalLayout> = {}
  const startupCwdRelative: Record<string, string> = {}
  for (const tab of terminalTabs) {
    const snapshot = session.terminalLayoutsByTabId[tab.id]
    if (snapshot) {
      terminalLayouts[tab.id] = projectTerminalLayout(snapshot)
    }
    const cwd = tab.startupCwd === undefined ? null : relativeWithin(worktreePath, tab.startupCwd)
    if (cwd !== null) {
      startupCwdRelative[tab.id] = cwd
    }
  }
  const editors = openFiles.map((file): RecoveryEditor => ({
    relativePath: file.relativePath,
    language: file.language,
    ...(file.isPreview !== undefined ? { isPreview: file.isPreview } : {}),
    ...(file.readOnly !== undefined ? { readOnly: file.readOnly } : {})
  }))
  return {
    tabs: (session.unifiedTabs?.[worktreeId] ?? []).map(
      ({ worktreeId: _worktreeId, executionHostId: _executionHostId, ...tab }): RecoveryTab =>
        withEditorBackingPath(tab, openFiles, worktreeId)
    ),
    groups: (session.tabGroups?.[worktreeId] ?? []).map(
      ({ worktreeId: _worktreeId, ...group }): RecoveryTabGroup => group
    ),
    groupLayout: session.tabGroupLayouts?.[worktreeId] ?? null,
    activeGroupId: session.activeGroupIdByWorktree?.[worktreeId] ?? null,
    terminalTabs: terminalTabs.map(sanitizeTerminalTabForRecovery),
    terminalLayouts,
    startupCwdRelative,
    editors,
    activeEditorRelativePath:
      findOpenFileByEditorId(openFiles, worktreeId, activeFileId)?.relativePath ?? null,
    browsers: projectBrowsers(session, worktreeId),
    activeBrowserId: session.activeBrowserTabIdByWorktree?.[worktreeId] ?? null,
    activeTabType: session.activeTabTypeByWorktree?.[worktreeId] ?? null,
    activeTabId: session.activeTabIdByWorktree?.[worktreeId] ?? null
  }
}
