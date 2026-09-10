import {
  WORKSPACE_SURFACE_SNAPSHOT_PROTOCOL,
  WorkspaceSurfaceSnapshotSchema
} from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceCanvasScope
} from '../../../../shared/runtime-types'
import {
  migrateMaestroWorkspaceCanvasStore,
  readWorkspaceCanvasDocument,
  reconcileStoredWorkspaceCanvas
} from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import { applyMaestroWorkspaceE2EQueryControl } from './maestro-workspace-e2e-query-control'
import { mergeMaestroWorkspaceTerminalInventory } from './maestro-workspace-leased-terminal-projection'
import type { MaestroWorkspaceSnapshotState } from './maestro-workspace-snapshot-state'
import {
  markWorkspaceSnapshotUnavailable,
  projectWorkspaceSurfaces,
  workspaceCanvasSelector
} from './maestro-workspace-surface-projection'
import { projectMaestroWorkspaceLinks } from './maestro-workspace-link-projection'
import type { MaestroWorkspaceCanvasRuntime } from './maestro-workspace-canvas-runtime'

export async function queryMaestroWorkspaceCanvas(params: {
  runtime: MaestroWorkspaceCanvasRuntime
  scope: RuntimeMaestroWorkspaceCanvasScope
  actorId: string
  previous?: MaestroWorkspaceSnapshotState
}): Promise<RuntimeMaestroWorkspaceCanvasQueryResult> {
  const { runtime, scope, actorId, previous } = params
  try {
    await applyMaestroWorkspaceE2EQueryControl()
    const database = runtime.getOrchestrationDb()
    const selector = workspaceCanvasSelector(scope)
    const [publishedSession, terminalList] = await Promise.all([
      runtime.listMobileSessionTabs(selector),
      runtime.listTerminals(selector, undefined, { includeVisualLayouts: false })
    ])
    const merged = mergeMaestroWorkspaceTerminalInventory({
      scope,
      session: publishedSession,
      terminalList,
      getLease: (terminal) =>
        database.getMaestroTerminalLeaseByHandle(terminal.handle) ??
        (terminal.incarnationId
          ? database.getMaestroTerminalLeaseByTab(
              scope.execution_host_id,
              scope.workspace_key,
              terminal.tabId,
              terminal.ptyId
                ? `${terminal.ptyId}:${terminal.incarnationId}`
                : terminal.incarnationId
            )
          : undefined)
    })
    const session = merged.session
    const sourceCursor = `${session.publicationEpoch}:${session.snapshotVersion}:${merged.inventoryCursor}`
    migrateMaestroWorkspaceCanvasStore(database)
    let canvas = readWorkspaceCanvasDocument(database, scope)
    const authorityRevision = previous
      ? previous.sourceCursor === sourceCursor
        ? previous.authorityRevision
        : Math.max(previous.authorityRevision, canvas.document.last_surface_revision) + 1
      : Math.max(1, canvas.document.last_surface_revision)
    const projection = projectWorkspaceSurfaces(
      scope,
      session,
      authorityRevision,
      (terminalHandle) => runtime.getTerminalProcessIncarnation(terminalHandle),
      canvas.document.annotations
    )
    const links = projectMaestroWorkspaceLinks({
      database,
      scope,
      session,
      surfaces: projection.surfaces
    })
    const snapshot = WorkspaceSurfaceSnapshotSchema.parse({
      schema_version: 1,
      protocol: WORKSPACE_SURFACE_SNAPSHOT_PROTOCOL,
      execution_host_id: scope.execution_host_id,
      workspace_key: scope.workspace_key,
      authority_revision: authorityRevision,
      authority_cursor: sourceCursor,
      state: 'ready',
      surfaces: projection.surfaces,
      unsupported:
        projection.unsupportedBrowserCount > 0
          ? [
              {
                content_type: 'browser-without-page-identity',
                count: projection.unsupportedBrowserCount
              }
            ]
          : [],
      ...links,
      capability: { available: true, reason: null },
      harness_overlay: null
    })
    const hasUnplacedSurface = Object.keys(snapshot.surfaces).some(
      (surfaceKey) => !canvas.document.placements[surfaceKey]
    )
    if (canvas.document.last_surface_revision !== authorityRevision || hasUnplacedSurface) {
      reconcileStoredWorkspaceCanvas(database, {
        scope,
        expected_revision: canvas.revision,
        idempotency_key: `snapshot-${authorityRevision}-${sourceCursor}`,
        snapshot
      })
      canvas = readWorkspaceCanvasDocument(database, scope)
    }
    return { status: 'available', actor_id: actorId, snapshot, canvas }
  } catch {
    return {
      status: 'unavailable',
      reason: 'authority-unreachable',
      liveness: 'unverifiable',
      ...(previous
        ? {
            last_known_snapshot: markWorkspaceSnapshotUnavailable(
              previous.snapshot.snapshot,
              'Authority unreachable.'
            )
          }
        : {})
    }
  }
}
