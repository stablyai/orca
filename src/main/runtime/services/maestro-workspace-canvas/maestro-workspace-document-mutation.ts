import { createHash } from 'node:crypto'
import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasMutationResult
} from '../../../../shared/runtime-types'
import type { WorkspaceCanvasDocumentRecord } from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import { writeWorkspaceCanvasDocument } from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'

type DocumentRequest = Extract<
  RuntimeMaestroWorkspaceCanvasMutation,
  {
    action:
      | 'set-placement'
      | 'set-viewport'
      | 'create-manual-link'
      | 'delete-manual-link'
      | 'decide-suggestion'
  }
>

export function mutateMaestroWorkspaceDocument(params: {
  database: OrchestrationDb
  request: DocumentRequest
  canvas: WorkspaceCanvasDocumentRecord
  snapshot: WorkspaceSurfaceSnapshot
}): RuntimeMaestroWorkspaceCanvasMutationResult {
  const { database, request, canvas, snapshot } = params
  const document = structuredClone(canvas.document)
  let surfaceId: RuntimeMaestroWorkspaceCanvasMutationResult['surface_id']
  if (request.action === 'set-placement') {
    surfaceId = request.surface_id
    const key = JSON.stringify([
      surfaceId.execution_host_id,
      surfaceId.workspace_key,
      surfaceId.unified_tab_id
    ])
    if (!snapshot.surfaces[key]) {
      return { status: 'stale', authority_revision: snapshot.authority_revision }
    }
    const top = Math.max(0, ...Object.values(document.placements).map((item) => item.z_order))
    document.placements[key] = { ...request.placement, z_order: top + 1 }
  } else if (request.action === 'set-viewport') {
    document.viewport = request.viewport
  } else if (request.action === 'create-manual-link') {
    if (
      request.source_surface_key === request.target_surface_key ||
      !snapshot.surfaces[request.source_surface_key] ||
      !snapshot.surfaces[request.target_surface_key]
    ) {
      return {
        status: 'stale',
        authority_revision: snapshot.authority_revision,
        reason: 'invalid_link_endpoints'
      }
    }
    const duplicate = document.manual_links.some(
      (link) =>
        (link.source_surface_key === request.source_surface_key &&
          link.target_surface_key === request.target_surface_key) ||
        (link.source_surface_key === request.target_surface_key &&
          link.target_surface_key === request.source_surface_key)
    )
    if (duplicate) {
      return {
        status: 'applied',
        authority_revision: snapshot.authority_revision,
        canvas_revision: canvas.revision
      }
    }
    document.manual_links.push({
      id: `link-${createHash('sha256').update(request.idempotency_key).digest('hex').slice(0, 24)}`,
      source_surface_key: request.source_surface_key,
      target_surface_key: request.target_surface_key,
      link_type: request.link_type,
      label: request.label,
      author_id: request.actor_id,
      created_at: new Date().toISOString(),
      revision: request.expected_canvas_revision + 1
    })
  } else if (request.action === 'delete-manual-link') {
    const next = document.manual_links.filter((link) => link.id !== request.link_id)
    if (next.length === document.manual_links.length) {
      return {
        status: 'stale',
        authority_revision: snapshot.authority_revision,
        reason: 'manual_link_not_found'
      }
    }
    document.manual_links = next
  } else {
    const suggestion = snapshot.suggested_links.find(
      (candidate) => candidate.fingerprint === request.fingerprint
    )
    if (!suggestion) {
      return {
        status: 'stale',
        authority_revision: snapshot.authority_revision,
        reason: 'suggestion_not_found'
      }
    }
    document.suggestion_decisions[request.fingerprint] = {
      fingerprint: request.fingerprint,
      suggestion_revision: suggestion.revision,
      state: request.decision,
      decided_by: request.actor_id,
      decided_at: new Date().toISOString(),
      accepted_link:
        request.decision === 'accepted'
          ? {
              source_surface_key: suggestion.source_surface_key,
              target_surface_key: suggestion.target_surface_key,
              link_type: request.link_type ?? suggestion.link_type,
              label: request.label ?? null,
              revision: request.expected_canvas_revision + 1
            }
          : null
    }
  }
  const receipt = writeWorkspaceCanvasDocument(database, {
    scope: request.scope,
    expected_revision: request.expected_canvas_revision,
    idempotency_key: `document:${request.idempotency_key}`,
    document
  })
  return {
    status: 'applied',
    authority_revision: snapshot.authority_revision,
    canvas_revision: receipt.revision,
    surface_id: surfaceId
  }
}
