import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { BrowserPage, BrowserWorkspace } from '../../shared/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../shared/browser-page-doc-location'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import type { Tab, TabGroup } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { SESSION_FIELDS_COPIED_BY_OWNER_KEY } from './profile-project-session-field-disposition'
import { mapMarkdownFrontmatterVisible } from './profile-session-markdown-transfer'

export {
  buildMarkdownFrontmatterIdMap,
  markdownFileIdCandidates
} from './profile-session-markdown-transfer'

export type SessionOwnerProjection = {
  mapOwnerKey: (ownerKey: string) => string | null
  mapWorktreeId: (worktreeId: string) => string
  projectSleepingAgentSession?: (
    record: SleepingAgentSessionRecord
  ) => SleepingAgentSessionRecord | null
  /** Projects source-partition focus scalars when the selected entities are dormant. */
  projectSessionFocus?: (args: {
    source: WorkspaceSessionState
    transferred: WorkspaceSessionState
    terminalTabIds: ReadonlySet<string>
  }) => void
}

export function extractSessionOwnersForTransfer(
  session: WorkspaceSessionState | undefined,
  projection: SessionOwnerProjection
): WorkspaceSessionState {
  const source = session ?? getDefaultWorkspaceSession()
  const transferred = getDefaultWorkspaceSession()
  const terminalTabIds = new Set<string>()
  const browserWorkspaceIds = new Set<string>()
  const mapOwnerRecord = <T>(
    record: Record<string, T> | undefined,
    mapValue: (value: T) => T
  ): Record<string, T> => {
    const next: Record<string, T> = {}
    for (const [ownerKey, value] of Object.entries(record ?? {})) {
      const nextOwnerKey = projection.mapOwnerKey(ownerKey)
      if (nextOwnerKey) {
        next[nextOwnerKey] = mapValue(value)
      }
    }
    return next
  }
  transferred.tabsByWorktree = mapOwnerRecord(source.tabsByWorktree, (tabs) =>
    tabs.map((tab) => {
      terminalTabIds.add(tab.id)
      return mapTerminalTab(tab, projection)
    })
  )
  // Newer sessions may persist a terminal only in the unified tab model while the legacy
  // terminal map is absent. Keep its layout and pane metadata attached to the transferred tab.
  for (const [ownerKey, tabs] of Object.entries(source.unifiedTabs ?? {})) {
    if (!projection.mapOwnerKey(ownerKey)) {
      continue
    }
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        terminalTabIds.add(tab.id)
        terminalTabIds.add(tab.entityId)
      }
    }
  }
  transferred.openFilesByWorktree = mapOwnerRecord(source.openFilesByWorktree, (files) =>
    files.map((file) => mapOpenFile(file, projection))
  )
  transferred.markdownFrontmatterVisible = mapMarkdownFrontmatterVisible(
    source.markdownFrontmatterVisible,
    source.openFilesByWorktree,
    projection
  )
  transferred.browserTabsByWorktree = mapOwnerRecord(source.browserTabsByWorktree, (tabs) =>
    tabs.map((tab) => {
      browserWorkspaceIds.add(tab.id)
      return mapBrowserWorkspace(tab, projection)
    })
  )
  transferred.browserPagesByWorkspace = copyBrowserPages(
    source.browserPagesByWorkspace,
    browserWorkspaceIds,
    projection
  )
  transferred.clientHostedBrowserPagesByWorktree = mapClientHostedBrowserPages(
    source.clientHostedBrowserPagesByWorktree,
    projection
  )
  for (const field of SESSION_FIELDS_COPIED_BY_OWNER_KEY) {
    const record = source[field] as Record<string, unknown> | undefined
    ;(transferred as Record<string, unknown>)[field] = mapOwnerRecord(record, (value) =>
      structuredClone(value)
    )
  }
  transferred.unifiedTabs = mapOwnerRecord(source.unifiedTabs, (tabs) =>
    tabs.map((tab) => mapUnifiedTab(tab, projection))
  )
  transferred.tabGroups = mapOwnerRecord(source.tabGroups, (groups) =>
    groups.map((group) => mapTabGroup(group, projection))
  )
  transferred.terminalLayoutsByTabId = Object.fromEntries(
    [...terminalTabIds].flatMap((tabId) => {
      const layout = source.terminalLayoutsByTabId[tabId]
      return layout ? [[tabId, structuredClone(layout)] as const] : []
    })
  )
  transferred.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
    Object.entries(source.terminalPtyIncarnationsByPaneKey ?? {}).filter(([paneKey]) =>
      paneBelongsToTabs(paneKey, terminalTabIds)
    )
  )
  transferred.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
    Object.entries(source.terminalSurfaceTombstonesByPaneKey ?? {}).flatMap(
      ([paneKey, tombstone]) =>
        projection.mapOwnerKey(tombstone.worktreeId)
          ? [
              [
                paneKey,
                {
                  ...structuredClone(tombstone),
                  worktreeId: projection.mapWorktreeId(tombstone.worktreeId)
                }
              ] as const
            ]
          : []
    )
  )
  projection.projectSessionFocus?.({
    source,
    transferred,
    terminalTabIds
  })
  if (projection.projectSleepingAgentSession) {
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      Object.entries(source.sleepingAgentSessionsByPaneKey ?? {}).flatMap(([paneKey, record]) => {
        const projected = projection.projectSleepingAgentSession?.(record)
        return projected ? [[paneKey, projected] as const] : []
      })
    )
    if (Object.keys(sleepingAgentSessionsByPaneKey).length > 0) {
      transferred.sleepingAgentSessionsByPaneKey = sleepingAgentSessionsByPaneKey
    }
  }
  transferred.activeWorktreeIdsOnShutdown = source.activeWorktreeIdsOnShutdown
    ?.filter((worktreeId) => projection.mapOwnerKey(worktreeId) !== null)
    .map(projection.mapWorktreeId)
  const activeWorktreeId = source.activeWorktreeId
    ? projection.mapOwnerKey(source.activeWorktreeId)
    : null
  if (activeWorktreeId) {
    transferred.activeWorktreeId = projection.mapWorktreeId(source.activeWorktreeId!)
  }
  const activeWorkspaceKey = source.activeWorkspaceKey
    ? projection.mapOwnerKey(source.activeWorkspaceKey)
    : null
  if (activeWorkspaceKey) {
    transferred.activeWorkspaceKey = activeWorkspaceKey as WorkspaceKey
  }
  return transferred
}

export function hasTransferredSessionState(session: WorkspaceSessionState): boolean {
  return (
    Boolean(
      session.activeRepoId ||
      session.activeWorktreeId ||
      session.activeWorkspaceKey ||
      session.activeWorkspaceExecutionHostId ||
      session.activeTabId
    ) ||
    Object.keys(session.tabsByWorktree).length > 0 ||
    Object.keys(session.openFilesByWorktree ?? {}).length > 0 ||
    Object.keys(session.markdownFrontmatterVisible ?? {}).length > 0 ||
    Object.keys(session.browserTabsByWorktree ?? {}).length > 0 ||
    Object.keys(session.browserPagesByWorkspace ?? {}).length > 0 ||
    Object.keys(session.clientHostedBrowserPagesByWorktree ?? {}).length > 0 ||
    Object.keys(session.unifiedTabs ?? {}).length > 0 ||
    Object.keys(session.tabGroups ?? {}).length > 0 ||
    Object.keys(session.terminalLayoutsByTabId ?? {}).length > 0 ||
    SESSION_FIELDS_COPIED_BY_OWNER_KEY.some(
      (field) =>
        Object.keys((session[field] as Record<string, unknown> | undefined) ?? {}).length > 0
    ) ||
    Object.keys(session.terminalSurfaceTombstonesByPaneKey ?? {}).length > 0 ||
    Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).length > 0 ||
    Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).length > 0 ||
    Boolean(session.activeWorktreeId || session.activeWorkspaceKey) ||
    (session.activeWorktreeIdsOnShutdown?.length ?? 0) > 0
  )
}

function mapTerminalTab(tab: TerminalTab, projection: SessionOwnerProjection): TerminalTab {
  const { pendingActivationSpawn: _pendingActivationSpawn, ...persisted } = tab
  return {
    ...structuredClone(persisted),
    worktreeId: projection.mapWorktreeId(tab.worktreeId)
  }
}

function mapOpenFile(
  file: PersistedOpenFile,
  projection: SessionOwnerProjection
): PersistedOpenFile {
  return {
    ...structuredClone(file),
    worktreeId: projection.mapWorktreeId(file.worktreeId)
  }
}

function mapBrowserWorkspace(
  workspace: BrowserWorkspace,
  projection: SessionOwnerProjection
): BrowserWorkspace {
  return {
    ...structuredClone(workspace),
    worktreeId: projection.mapWorktreeId(workspace.worktreeId),
    ...(workspace.docLocation
      ? {
          docLocation: remapBrowserPageDocLocation(
            workspace.docLocation,
            workspace.docLocation.worktreeId,
            projection.mapWorktreeId(workspace.docLocation.worktreeId)
          )
        }
      : {}),
    ...(workspace.docLocation
      ? {
          docLocation: remapBrowserPageDocLocation(
            workspace.docLocation,
            workspace.docLocation.worktreeId,
            projection.mapWorktreeId(workspace.docLocation.worktreeId)
          )
        }
      : {}),
    sessionProfileId: null,
    sessionPartition: null
  }
}

function mapBrowserPage(page: BrowserPage, projection: SessionOwnerProjection): BrowserPage {
  return {
    ...structuredClone(page),
    worktreeId: projection.mapWorktreeId(page.worktreeId),
    ...(page.docLocation
      ? {
          docLocation: remapBrowserPageDocLocation(
            page.docLocation,
            page.docLocation.worktreeId,
            projection.mapWorktreeId(page.docLocation.worktreeId)
          )
        }
      : {})
  }
}

function copyBrowserPages(
  pagesByWorkspace: Record<string, BrowserPage[]> | undefined,
  workspaceIds: ReadonlySet<string>,
  projection: SessionOwnerProjection
): Record<string, BrowserPage[]> {
  const next: Record<string, BrowserPage[]> = {}
  for (const [workspaceId, pages] of Object.entries(pagesByWorkspace ?? {})) {
    if (workspaceIds.has(workspaceId)) {
      next[workspaceId] = pages.map((page) => mapBrowserPage(page, projection))
    }
  }
  return next
}

function mapClientHostedBrowserPages(
  pagesByWorktree: WorkspaceSessionState['clientHostedBrowserPagesByWorktree'],
  projection: SessionOwnerProjection
): NonNullable<WorkspaceSessionState['clientHostedBrowserPagesByWorktree']> {
  const next: NonNullable<WorkspaceSessionState['clientHostedBrowserPagesByWorktree']> = {}
  for (const [ownerKey, pages] of Object.entries(pagesByWorktree ?? {})) {
    const nextOwnerKey = projection.mapOwnerKey(ownerKey)
    if (!nextOwnerKey) {
      continue
    }
    next[nextOwnerKey] = pages.map((page) => ({
      // `workspaceId` is the browser-workspace entity id, not the worktree owner key. Browser
      // workspace ids remain stable across an owner transfer; only the enclosing map key moves.
      ...structuredClone(page)
    }))
  }
  return next
}

function mapUnifiedTab(tab: Tab, projection: SessionOwnerProjection): Tab {
  return {
    ...structuredClone(tab),
    worktreeId: projection.mapWorktreeId(tab.worktreeId)
  }
}

function mapTabGroup(group: TabGroup, projection: SessionOwnerProjection): TabGroup {
  return {
    ...structuredClone(group),
    worktreeId: projection.mapWorktreeId(group.worktreeId)
  }
}

function paneBelongsToTabs(paneKey: string, tabIds: ReadonlySet<string>): boolean {
  const separator = paneKey.lastIndexOf(':')
  return separator > 0 && tabIds.has(paneKey.slice(0, separator))
}
