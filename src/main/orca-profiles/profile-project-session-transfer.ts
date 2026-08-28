import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  BrowserPage,
  BrowserPageDocLocation,
  BrowserWorkspace
} from '../../shared/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../shared/browser-page-doc-location'
import type { Tab, TabGroup } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { SESSION_FIELDS_COPIED_BY_OWNER_KEY } from './profile-project-session-field-disposition'
import {
  isRepoWorktreeId,
  rekeyOwnerKey,
  rekeyWorktreeId
} from './profile-project-worktree-identity'

export function extractHostSessionsForTransfer(
  sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> | undefined,
  oldRepoId: string,
  newRepoId: string
): Partial<Record<ExecutionHostId, WorkspaceSessionState>> {
  const next: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [hostId, session] of Object.entries(sessions ?? {})) {
    if (!session) {
      continue
    }
    const transferred = extractSessionForTransfer(session, oldRepoId, newRepoId)
    if (hasTransferredSessionState(transferred)) {
      next[hostId as ExecutionHostId] = transferred
    }
  }
  return next
}

function hasTransferredSessionState(session: WorkspaceSessionState): boolean {
  return (
    Object.keys(session.tabsByWorktree).length > 0 ||
    Object.keys(session.openFilesByWorktree ?? {}).length > 0 ||
    Object.keys(session.browserTabsByWorktree ?? {}).length > 0 ||
    Object.keys(session.unifiedTabs ?? {}).length > 0 ||
    Object.keys(session.tabGroups ?? {}).length > 0 ||
    Object.keys(session.lastVisitedAtByWorktreeId ?? {}).length > 0 ||
    Object.keys(session.terminalTopologyRevisionByRepoId ?? {}).length > 0
  )
}

export function extractSessionForTransfer(
  session: WorkspaceSessionState | undefined,
  oldRepoId: string,
  newRepoId: string
): WorkspaceSessionState {
  const source = session ?? getDefaultWorkspaceSession()
  const transferred = getDefaultWorkspaceSession()
  const copiedTerminalTabIds = new Set<string>()
  const copiedBrowserWorkspaceIds = new Set<string>()
  const mapOwnerRecord = <T>(
    record: Record<string, T> | undefined,
    mapValue: (value: T) => T
  ): Record<string, T> => {
    const next: Record<string, T> = {}
    for (const [ownerKey, value] of Object.entries(record ?? {})) {
      const nextOwnerKey = rekeyOwnerKey(oldRepoId, newRepoId, ownerKey)
      if (nextOwnerKey) {
        next[nextOwnerKey] = mapValue(value)
      }
    }
    return next
  }
  transferred.tabsByWorktree = mapOwnerRecord(source.tabsByWorktree, (tabs) =>
    tabs.map((tab) => {
      copiedTerminalTabIds.add(tab.id)
      return rekeyTerminalTab(tab, oldRepoId, newRepoId)
    })
  )
  transferred.openFilesByWorktree = mapOwnerRecord(source.openFilesByWorktree, (files) =>
    files.map((file) => rekeyOpenFile(file, oldRepoId, newRepoId))
  )
  transferred.browserTabsByWorktree = mapOwnerRecord(source.browserTabsByWorktree, (tabs) =>
    tabs.map((tab) => {
      copiedBrowserWorkspaceIds.add(tab.id)
      return rekeyBrowserWorkspace(tab, oldRepoId, newRepoId)
    })
  )
  transferred.browserPagesByWorkspace = copyBrowserPages(
    source.browserPagesByWorkspace,
    copiedBrowserWorkspaceIds,
    oldRepoId,
    newRepoId
  )
  // Driven by the census so a field cannot be added to the session type and forgotten here. The
  // census is also where a field's deliberate non-transfer is recorded -- notably the runtime's
  // client-hosted rows, which name a paired device this payload does not carry.
  for (const field of SESSION_FIELDS_COPIED_BY_OWNER_KEY) {
    const record = source[field] as Record<string, unknown> | undefined
    ;(transferred as Record<string, unknown>)[field] = mapOwnerRecord(record, (value) =>
      structuredClone(value)
    )
  }
  transferred.unifiedTabs = mapOwnerRecord(source.unifiedTabs, (tabs) =>
    tabs.map((tab) => rekeyUnifiedTab(tab, oldRepoId, newRepoId))
  )
  transferred.tabGroups = mapOwnerRecord(source.tabGroups, (groups) =>
    groups.map((group) => rekeyTabGroup(group, oldRepoId, newRepoId))
  )
  transferred.terminalLayoutsByTabId = {}
  for (const tabId of copiedTerminalTabIds) {
    const layout = source.terminalLayoutsByTabId[tabId]
    if (layout) {
      transferred.terminalLayoutsByTabId[tabId] = structuredClone(layout)
    }
  }
  transferred.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
    Object.entries(source.terminalPtyIncarnationsByPaneKey ?? {}).filter(([paneKey]) => {
      const separator = paneKey.lastIndexOf(':')
      return separator > 0 && copiedTerminalTabIds.has(paneKey.slice(0, separator))
    })
  )
  transferred.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
    Object.entries(source.terminalSurfaceTombstonesByPaneKey ?? {}).flatMap(
      ([paneKey, tombstone]) =>
        isRepoWorktreeId(oldRepoId, tombstone.worktreeId)
          ? [
              [
                paneKey,
                {
                  ...structuredClone(tombstone),
                  worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, tombstone.worktreeId)
                }
              ] as const
            ]
          : []
    )
  )
  transferred.activeWorktreeIdsOnShutdown = source.activeWorktreeIdsOnShutdown
    ?.filter((worktreeId) => isRepoWorktreeId(oldRepoId, worktreeId))
    .map((worktreeId) => rekeyWorktreeId(oldRepoId, newRepoId, worktreeId))
  if (source.activeWorktreeId && isRepoWorktreeId(oldRepoId, source.activeWorktreeId)) {
    transferred.activeWorktreeId = rekeyWorktreeId(oldRepoId, newRepoId, source.activeWorktreeId)
  }
  const activeScope = source.activeWorkspaceKey
    ? parseWorkspaceKey(source.activeWorkspaceKey)
    : null
  if (activeScope?.type === 'worktree' && isRepoWorktreeId(oldRepoId, activeScope.worktreeId)) {
    transferred.activeWorkspaceKey = worktreeWorkspaceKey(
      rekeyWorktreeId(oldRepoId, newRepoId, activeScope.worktreeId)
    )
  }
  return transferred
}

function rekeyTerminalTab(tab: TerminalTab, oldRepoId: string, newRepoId: string): TerminalTab {
  return {
    ...structuredClone(tab),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, tab.worktreeId)
  }
}

function rekeyOpenFile(
  file: PersistedOpenFile,
  oldRepoId: string,
  newRepoId: string
): PersistedOpenFile {
  return {
    ...structuredClone(file),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, file.worktreeId)
  }
}

function rekeyBrowserWorkspace(
  workspace: BrowserWorkspace,
  oldRepoId: string,
  newRepoId: string
): BrowserWorkspace {
  return {
    ...structuredClone(workspace),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, workspace.worktreeId),
    ...(workspace.docLocation
      ? { docLocation: rekeyBrowserDocLocation(workspace.docLocation, oldRepoId, newRepoId) }
      : {}),
    // Why: both the session profile and the resolved partition string are
    // source-profile-scoped; carrying either across would point the restored
    // pane at a partition the target profile's allowlist rejects.
    sessionProfileId: null,
    sessionPartition: null
  }
}

function rekeyBrowserPage(page: BrowserPage, oldRepoId: string, newRepoId: string): BrowserPage {
  return {
    ...structuredClone(page),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, page.worktreeId),
    ...(page.docLocation
      ? { docLocation: rekeyBrowserDocLocation(page.docLocation, oldRepoId, newRepoId) }
      : {})
  }
}

function rekeyBrowserDocLocation(
  location: BrowserPageDocLocation,
  oldRepoId: string,
  newRepoId: string
): BrowserPageDocLocation {
  const nextWorktreeId = rekeyWorktreeId(oldRepoId, newRepoId, location.worktreeId)
  return remapBrowserPageDocLocation(location, location.worktreeId, nextWorktreeId)
}

function copyBrowserPages(
  pagesByWorkspace: Record<string, BrowserPage[]> | undefined,
  workspaceIds: ReadonlySet<string>,
  oldRepoId: string,
  newRepoId: string
): Record<string, BrowserPage[]> {
  const next: Record<string, BrowserPage[]> = {}
  for (const [workspaceId, pages] of Object.entries(pagesByWorkspace ?? {})) {
    if (workspaceIds.has(workspaceId)) {
      next[workspaceId] = pages.map((page) => rekeyBrowserPage(page, oldRepoId, newRepoId))
    }
  }
  return next
}

function rekeyUnifiedTab(tab: Tab, oldRepoId: string, newRepoId: string): Tab {
  return {
    ...structuredClone(tab),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, tab.worktreeId)
  }
}

function rekeyTabGroup(group: TabGroup, oldRepoId: string, newRepoId: string): TabGroup {
  return {
    ...structuredClone(group),
    worktreeId: rekeyWorktreeId(oldRepoId, newRepoId, group.worktreeId)
  }
}
