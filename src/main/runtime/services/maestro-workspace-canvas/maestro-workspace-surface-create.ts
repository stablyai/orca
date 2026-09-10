import { createHash } from 'node:crypto'
import {
  workspaceSurfaceKey,
  type WorkspaceSurfaceId
} from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasQueryResult
} from '../../../../shared/runtime-types'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { writeWorkspaceCanvasDocument } from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import { workspaceCanvasSelector } from './maestro-workspace-surface-projection'
import type { MaestroWorkspaceCanvasRuntime } from './maestro-workspace-canvas-authority'

type CreateRequest = Extract<RuntimeMaestroWorkspaceCanvasMutation, { action: 'create' }>
type Available = Extract<RuntimeMaestroWorkspaceCanvasQueryResult, { status: 'available' }>

function persistInitialPlacement(params: {
  database: OrchestrationDb
  request: CreateRequest
  canvas: Available['canvas']
  surfaceId: WorkspaceSurfaceId
}): number {
  if (!params.request.placement) {
    return params.canvas.revision
  }
  const document = structuredClone(params.canvas.document)
  document.placements[workspaceSurfaceKey(params.surfaceId)] = params.request.placement
  return writeWorkspaceCanvasDocument(params.database, {
    scope: params.request.scope,
    expected_revision: params.canvas.revision,
    idempotency_key: `placement:${params.request.idempotency_key}`,
    document
  }).revision
}

export async function createMaestroWorkspaceSurface(params: {
  runtime: MaestroWorkspaceCanvasRuntime
  database: OrchestrationDb
  request: CreateRequest
  before: Available
  query: () => Promise<RuntimeMaestroWorkspaceCanvasQueryResult>
}): Promise<{ surfaceId: WorkspaceSurfaceId; canvasRevision: number }> {
  const { runtime, database, request, before } = params
  const selector = workspaceCanvasSelector(request.scope)
  if (request.surface_type === 'terminal') {
    const created = await runtime.createMobileSessionTerminal(selector, {
      clientMutationId: request.idempotency_key,
      ...(request.agent ? { agent: request.agent } : {}),
      activate: false,
      select: false,
      // Canvas is the first-class live surface. Spawn through main so a
      // background tab does not depend on its hidden desktop pane mounting
      // before the Canvas preview can attach, render, and accept input.
      runtimeOwned: true
    })
    const surfaceId = { ...request.scope, unified_tab_id: created.tab.parentTabId }
    return {
      surfaceId,
      canvasRevision: persistInitialPlacement({
        database,
        request,
        canvas: before.canvas,
        surfaceId
      })
    }
  }
  if (request.surface_type === 'browser') {
    const page = `maestro-${createHash('sha256').update(request.idempotency_key).digest('hex').slice(0, 24)}`
    const created = await runtime.browserTabCreate({
      worktree: selector,
      url: 'about:blank',
      page,
      waitForRegistration: true,
      activate: false,
      focus: false
    })
    const projected = await params.query()
    if (projected.status !== 'available') {
      throw new Error('browser_surface_unverifiable')
    }
    const surface = Object.values(projected.snapshot.surfaces).find(
      (candidate) =>
        candidate.binding.kind === 'browser' &&
        candidate.binding.browser_page_id === created.browserPageId
    )
    if (!surface) {
      throw new Error('browser_surface_identity_unverifiable')
    }
    return {
      surfaceId: surface.id,
      canvasRevision: persistInitialPlacement({
        database,
        request,
        canvas: projected.canvas,
        surfaceId: surface.id
      })
    }
  }
  const suffix = createHash('sha256').update(request.idempotency_key).digest('hex').slice(0, 24)
  const relativePath = `.orca/maestro/annotation-${suffix}.md`
  const title = request.title?.trim().replace(/\s+/g, ' ') || `${request.annotation.tone} note`
  const created = await runtime.createMaestroWorkspaceAnnotation(
    selector,
    relativePath,
    `# ${title}\n\n${request.annotation.text}`
  )
  const acknowledged = await runtime.commandMaestroWorkspaceTab({
    kind: 'open-annotation',
    worktreeId: created.worktreeId,
    filePath: created.filePath,
    relativePath,
    title
  })
  const renamed = await runtime.commandMaestroWorkspaceTab({
    kind: 'rename',
    worktreeId: created.worktreeId,
    tabId: acknowledged.tabId,
    title
  })
  if (renamed.tabId !== acknowledged.tabId) {
    throw new Error('annotation_title_identity_mismatch')
  }
  const projected = await params.query()
  if (projected.status !== 'available') {
    throw new Error('annotation_surface_unverifiable')
  }
  const surfaceId = { ...request.scope, unified_tab_id: acknowledged.tabId }
  const key = workspaceSurfaceKey(surfaceId)
  const document = structuredClone(projected.canvas.document)
  document.annotations[key] = {
    surface_key: key,
    relative_path: relativePath,
    tone: request.annotation.tone,
    created_by: request.actor_id,
    created_at: new Date().toISOString()
  }
  if (request.placement) {
    document.placements[key] = request.placement
  }
  const receipt = writeWorkspaceCanvasDocument(database, {
    scope: request.scope,
    expected_revision: projected.canvas.revision,
    idempotency_key: `document:${request.idempotency_key}`,
    document
  })
  return { surfaceId, canvasRevision: receipt.revision }
}
