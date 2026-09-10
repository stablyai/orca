import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceContentReadResult,
  RuntimeMaestroWorkspaceCanvasScope
} from '../../../../shared/runtime-types'
import { workspaceCanvasSelector } from './maestro-workspace-surface-projection'
import type { MaestroWorkspaceCanvasRuntime } from './maestro-workspace-canvas-authority'

export async function readMaestroWorkspaceContent(params: {
  runtime: MaestroWorkspaceCanvasRuntime
  scope: RuntimeMaestroWorkspaceCanvasScope
  surfaceId: NonNullable<Parameters<typeof workspaceSurfaceKey>[0]>
  query: () => Promise<RuntimeMaestroWorkspaceCanvasQueryResult>
}): Promise<RuntimeMaestroWorkspaceContentReadResult> {
  const current = await params.query()
  if (current.status !== 'available') {
    throw new Error('workspace_content_unverifiable')
  }
  const surface = current.snapshot.surfaces[workspaceSurfaceKey(params.surfaceId)]
  if (!surface || surface.binding.kind !== 'content' || !surface.binding.source) {
    throw new Error('workspace_content_identity_stale')
  }
  const selector = workspaceCanvasSelector(params.scope)
  if (surface.binding.source.is_dirty) {
    const exact = await params.runtime.commandMaestroWorkspaceTab({
      kind: 'read-content',
      worktreeId: selector.slice(3),
      tabId: surface.id.unified_tab_id
    })
    if (
      exact.tabId !== surface.id.unified_tab_id ||
      exact.content === undefined ||
      !exact.modelRevision
    ) {
      throw new Error('workspace_content_model_unverifiable')
    }
    return { tabId: exact.tabId, content: exact.content, modelRevision: exact.modelRevision }
  }
  const file = await params.runtime.readMobileFile(selector, surface.binding.source.relative_path)
  if (file.truncated) {
    throw new Error('workspace_content_truncated')
  }
  return {
    tabId: surface.id.unified_tab_id,
    content: file.content,
    modelRevision: surface.binding.model_revision
  }
}
