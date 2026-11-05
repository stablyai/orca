import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { workspaceSurfaceSchema } from '../../shared/workspace-surfaces/surface-schema'

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('surface_row_unreadable')
  }
  return JSON.parse(value)
}

export function rowKey(surface: Pick<SurfaceKey, 'workspaceId' | 'hostTabId'>): string {
  return JSON.stringify([surface.workspaceId, surface.hostTabId])
}

export function parseSurface(value: unknown): WorkspaceSurface {
  return workspaceSurfaceSchema.parse(parseJson(value))
}
