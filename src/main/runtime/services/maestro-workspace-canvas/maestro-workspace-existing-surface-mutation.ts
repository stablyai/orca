import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasMutationResult,
  RuntimeMaestroWorkspaceCanvasQueryResult
} from '../../../../shared/runtime-types'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { writeWorkspaceCanvasDocument } from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import type { MaestroWorkspaceCanvasRuntime } from './maestro-workspace-canvas-authority'

type Available = Extract<RuntimeMaestroWorkspaceCanvasQueryResult, { status: 'available' }>
type ExistingSurfaceRequest = Extract<
  RuntimeMaestroWorkspaceCanvasMutation,
  { action: 'rename' | 'focus' | 'close' | 'update-annotation' }
>

export async function mutateExistingMaestroWorkspaceSurface(params: {
  runtime: MaestroWorkspaceCanvasRuntime
  database: OrchestrationDb
  request: ExistingSurfaceRequest
  before: Available
  selector: string
}): Promise<{
  surfaceId: NonNullable<RuntimeMaestroWorkspaceCanvasMutationResult['surface_id']>
  canvasRevision: number
  result?: RuntimeMaestroWorkspaceCanvasMutationResult
}> {
  const { runtime, database, request, before, selector } = params
  const surfaceId = request.surface_id
  const key = workspaceSurfaceKey(surfaceId)
  const surface = before.snapshot.surfaces[key]
  if (!surface) {
    return {
      surfaceId,
      canvasRevision: before.canvas.revision,
      result: { status: 'stale', authority_revision: before.snapshot.authority_revision }
    }
  }
  if (request.action === 'update-annotation') {
    if (surface.binding.kind !== 'content' || !surface.binding.annotation) {
      return {
        surfaceId,
        canvasRevision: before.canvas.revision,
        result: {
          status: 'stale',
          authority_revision: before.snapshot.authority_revision,
          reason: 'annotation_surface_required'
        }
      }
    }
    if (request.content !== undefined) {
      const current = await runtime.readMobileMarkdownTab(selector, surface.id.unified_tab_id)
      if (!current.editable) {
        throw new Error(current.readOnlyReason ?? 'annotation_read_only')
      }
      const saved = await runtime.saveMobileMarkdownTab(
        selector,
        surface.id.unified_tab_id,
        current.version,
        request.content
      )
      if (saved.tabId !== surface.id.unified_tab_id || saved.content !== request.content) {
        throw new Error('annotation_save_identity_mismatch')
      }
    }
    const document = structuredClone(before.canvas.document)
    const annotation = document.annotations[key]
    if (!annotation) {
      return {
        surfaceId,
        canvasRevision: before.canvas.revision,
        result: {
          status: 'stale',
          authority_revision: before.snapshot.authority_revision,
          reason: 'annotation_metadata_missing'
        }
      }
    }
    document.annotations[key] = { ...annotation, tone: request.tone }
    const receipt = writeWorkspaceCanvasDocument(database, {
      scope: request.scope,
      expected_revision: request.expected_canvas_revision,
      idempotency_key: `document:${request.idempotency_key}`,
      document
    })
    return { surfaceId, canvasRevision: receipt.revision }
  }
  if (request.action === 'rename') {
    const acknowledged = await runtime.commandMaestroWorkspaceTab({
      kind: 'rename',
      worktreeId: selector.slice(3),
      tabId: surface.id.unified_tab_id,
      title: request.title
    })
    if (acknowledged.tabId !== surface.id.unified_tab_id) {
      throw new Error('rename_tab_identity_mismatch')
    }
    return { surfaceId, canvasRevision: before.canvas.revision }
  }
  if (request.action === 'focus') {
    if (surface.binding.kind === 'terminal') {
      await runtime.activateMobileSessionTab(
        selector,
        surface.id.unified_tab_id,
        surface.binding.pane_key
      )
    } else {
      const acknowledged = await runtime.commandMaestroWorkspaceTab({
        kind: 'focus',
        worktreeId: selector.slice(3),
        tabId: surface.id.unified_tab_id
      })
      if (acknowledged.tabId !== surface.id.unified_tab_id) {
        throw new Error('focus_tab_identity_mismatch')
      }
    }
    const document = structuredClone(before.canvas.document)
    const placement = document.placements[key]
    if (!placement) {
      return { surfaceId, canvasRevision: before.canvas.revision }
    }
    const top = Math.max(0, ...Object.values(document.placements).map((item) => item.z_order))
    document.placements[key] = { ...placement, z_order: top + 1 }
    const receipt = writeWorkspaceCanvasDocument(database, {
      scope: request.scope,
      expected_revision: request.expected_canvas_revision,
      idempotency_key: `document:${request.idempotency_key}`,
      document
    })
    return { surfaceId, canvasRevision: receipt.revision }
  }
  const closed = await runtime.closeMobileSessionTab(selector, surface.id.unified_tab_id, {
    reason: 'user'
  })
  if (closed.refused) {
    return {
      surfaceId,
      canvasRevision: before.canvas.revision,
      result: {
        status: 'cancelled',
        authority_revision: before.snapshot.authority_revision,
        surface_id: surfaceId,
        reason: closed.refusalReason
      }
    }
  }
  const document = structuredClone(before.canvas.document)
  delete document.placements[key]
  delete document.annotations[key]
  document.manual_links = document.manual_links.filter(
    (link) => link.source_surface_key !== key && link.target_surface_key !== key
  )
  const receipt = writeWorkspaceCanvasDocument(database, {
    scope: request.scope,
    expected_revision: request.expected_canvas_revision,
    idempotency_key: `document:${request.idempotency_key}`,
    document
  })
  return { surfaceId, canvasRevision: receipt.revision }
}
