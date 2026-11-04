import { randomUUID } from 'node:crypto'
import type { AgentType } from '../../shared/agent-status-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  surfaceContentOf,
  type WorkspaceSurface
} from '../../shared/workspace-surfaces/surface-content'
import {
  reserveImportedSurfaceIdentities,
  retainSurfaceReference,
  type SurfaceMigrationEvidence
} from './surface-migration-identities'

export type LegacySurfaceChat = {
  workspaceId: string
  tabId: string
  sessionId: string
  agent: AgentType
  createdAt: number
}

/** Startup only: native-chat index facts supplement the saved window, including hidden windows. */
export function seedWorkspaceSurfaces(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  chats: readonly LegacySurfaceChat[],
  mintId: () => string = randomUUID,
  evidence: SurfaceMigrationEvidence = { retainedReferences: [], identityMappings: [] },
  retainNativePresentation = true
): WorkspaceSurface[] {
  const loaded = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
  const surfaces: WorkspaceSurface[] = []
  const tabIds = Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
    tabs
      .filter((tab) => tab.contentType !== 'terminal' && tab.contentType !== 'agent-session')
      .map((tab) => tab.id)
  )
  const sessions = new Set<string>()
  const append = (surface: WorkspaceSurface): void => {
    if (surface.content?.kind === 'agent-session') {
      if (sessions.has(surface.content.sessionId)) {
        retainSurfaceReference(evidence, {
          workspaceId: surface.workspaceId,
          kind: 'agent-session',
          id: surface.hostTabId,
          raw: {
            hostTabId: surface.hostTabId,
            ...surface.content,
            createdAt: surface.createdAt
          }
        })
        return
      }
      sessions.add(surface.content.sessionId)
    }
    surfaces.push(surface)
  }
  for (const [workspaceId, workspace] of Object.entries(loaded.layout.workspaces)) {
    for (const tab of workspace.tabs) {
      if (tab.kind !== 'terminal' && tab.kind !== 'agent-session') {
        continue
      }
      const content = surfaceContentOf(tab, workspace, null, mintId)
      if (content) {
        append({
          hostId,
          workspaceId,
          hostTabId: tab.id,
          occurrence: mintId(),
          revision: 1,
          createdAt: tab.createdAt,
          content
        })
      }
    }
  }
  recoverDiscardedTerminalRows(hostId, session, surfaces, evidence, mintId)
  for (const chat of chats) {
    append({
      hostId,
      workspaceId: chat.workspaceId,
      hostTabId: chat.tabId,
      occurrence: mintId(),
      revision: 1,
      createdAt: chat.createdAt,
      content: { kind: 'agent-session', sessionId: chat.sessionId, agent: chat.agent }
    })
  }
  for (const [workspaceId, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (retainNativePresentation && tab.contentType === 'agent-session') {
        retainSurfaceReference(evidence, {
          workspaceId,
          kind: 'agent-session',
          id: tab.id,
          raw: JSON.parse(JSON.stringify(tab))
        })
      }
    }
  }
  return reserveImportedSurfaceIdentities(surfaces, [], tabIds, evidence, mintId)
}

/** The ordinary view loader chooses one home; migration must also retain the rejected resource claims. */
function recoverDiscardedTerminalRows(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  surfaces: WorkspaceSurface[],
  evidence: SurfaceMigrationEvidence,
  mintId: () => string
): void {
  const allRows = Object.entries(session.tabsByWorktree)
  const entities = new Set(allRows.flatMap(([, rows]) => rows.map((row) => row.id)))
  for (const [workspaceId, rows] of allRows) {
    for (const row of rows) {
      const held = surfaces.find(
        (surface) =>
          surface.workspaceId === workspaceId &&
          surface.content?.kind === 'terminal' &&
          surface.content.entityId === row.id
      )
      const heldPtyIds = new Set(
        held?.content?.kind === 'terminal'
          ? Object.values(held.content.leaves).flatMap((leaf) =>
              leaf.facts.ptyId ? [leaf.facts.ptyId] : []
            )
          : []
      )
      const savedPtyIds = [
        row.ptyId,
        ...Object.values(session.terminalLayoutsByTabId[row.id]?.ptyIdsByLeafId ?? {})
      ]
      if (held && savedPtyIds.every((id) => !id || heldPtyIds.has(id))) {
        continue
      }
      retainSurfaceReference(evidence, {
        workspaceId,
        kind: 'terminal',
        id: row.id,
        raw: JSON.parse(JSON.stringify(row))
      })
      const savedLayout = session.terminalLayoutsByTabId[row.id]
      const independentRow = Boolean(
        row.ptyId &&
        savedLayout &&
        !Object.values(savedLayout.ptyIdsByLeafId ?? {}).includes(row.ptyId)
      )
      const isolated = loadWorkspaceLayoutWithoutReport(
        hostId,
        {
          ...session,
          tabsByWorktree: { [workspaceId]: [row] },
          // A conflicting row process cannot inherit another process's layout or incarnation.
          ...(independentRow
            ? {
                terminalLayoutsByTabId: {},
                terminalPtyIncarnationsByPaneKey: undefined,
                sleepingAgentSessionsByPaneKey: undefined
              }
            : {}),
          unifiedTabs: {
            [workspaceId]: (session.unifiedTabs?.[workspaceId] ?? []).filter(
              (tab) => tab.contentType === 'terminal' && tab.entityId === row.id
            )
          }
        },
        nameBasedLoadContext()
      ).layout.workspaces[workspaceId]
      const tab = isolated?.tabs.find((candidate) => candidate.kind === 'terminal')
      const content = tab && isolated ? surfaceContentOf(tab, isolated, null, mintId) : null
      if (tab && content) {
        if (held && heldPtyIds.size === 0) {
          held.content = content
          continue
        }
        surfaces.push({
          hostId,
          workspaceId,
          hostTabId: tab.id,
          occurrence: mintId(),
          revision: 1,
          createdAt: tab.createdAt,
          content
        })
      }
    }
  }
  const heldResources = new Set(
    surfaces.flatMap((surface) =>
      surface.content?.kind === 'terminal'
        ? Object.values(surface.content.leaves).flatMap((leaf) =>
            leaf.facts.ptyId ? [leaf.facts.ptyId] : []
          )
        : []
    )
  )
  for (const [id, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    if (
      !entities.has(id) ||
      Object.values(layout.ptyIdsByLeafId ?? {}).some((ptyId) => !heldResources.has(ptyId))
    ) {
      retainSurfaceReference(evidence, {
        workspaceId: session.activeWorktreeId ?? 'unplaced',
        kind: 'terminal-layout',
        id,
        raw: JSON.parse(JSON.stringify(layout))
      })
    }
  }
}
