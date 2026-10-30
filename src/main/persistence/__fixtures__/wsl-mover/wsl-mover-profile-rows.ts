import type { Project } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

export type WslMoverProfileSide = 'source' | 'destination'

export const WSL_MOVER_DISTRO = 'Ubuntu'

export type WslMoverPaths = {
  side: WslMoverProfileSide
  /** wsl$ exercises the legacy UNC spelling. */
  at: (linuxPath: string, spelling?: 'wsl.localhost' | 'wsl$') => string
  fileUrl: (linuxPath: string) => string
}

export function wslMoverPaths(side: WslMoverProfileSide): WslMoverPaths {
  return {
    side,
    at: (linuxPath, spelling = 'wsl.localhost') =>
      side === 'source'
        ? `\\\\${spelling}\\${WSL_MOVER_DISTRO}${linuxPath.replaceAll('/', '\\')}`
        : linuxPath,
    fileUrl: (linuxPath) =>
      side === 'source'
        ? `file://wsl.localhost/${WSL_MOVER_DISTRO}${linuxPath}`
        : `file://${linuxPath}`
  }
}

export function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 0 }
}

export function project(id: string, sourceRepoIds: string[]): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 0,
    updatedAt: 0
  }
}

export function worktreeMeta(displayName: string): WorktreeMeta {
  return {
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: 42,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: true,
    sortOrder: 0,
    lastActivityAt: 1,
    hostId: 'local'
  }
}

export function terminalTab(
  id: string,
  worktreeId: string,
  startupCwd: string | null,
  ptyId: string | null
): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: `terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(startupCwd ? { startupCwd } : {})
  }
}

export function unifiedTab(id: string, worktreeId: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: id.startsWith('tab-') ? 'terminal' : 'editor',
    label: id.split(/[\\/]/).pop() ?? id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

export function tabGroup(id: string, worktreeId: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId, activeTabId: tabOrder[0] ?? null, tabOrder }
}
