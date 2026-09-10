import type { WorkspaceCanvasDocument } from '../../../../../shared/maestro-document-contract'
import type { WorkspaceSurface } from '../../../../../shared/maestro-workspace-canvas'

export function defaultWorkspaceCanvasPlacement(
  index: number,
  surface: WorkspaceSurface
): WorkspaceCanvasDocument['placements'][string] {
  const isAnnotation = surface.binding.kind === 'content' && surface.binding.annotation != null
  const size =
    surface.content_type === 'terminal'
      ? { width: 760, height: 530 }
      : surface.content_type === 'browser'
        ? { width: 680, height: 480 }
        : isAnnotation
          ? { width: 440, height: 360 }
          : { width: 360, height: 260 }
  return {
    position: { x: (index % 3) * 800, y: Math.floor(index / 3) * 570 },
    size,
    collapsed: false,
    z_order: index
  }
}
