import { randomUUID } from 'node:crypto'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'

export function orphanSurfaceRetirements(
  surfaces: readonly WorkspaceSurface[]
): SurfaceStorageMutation[] {
  return surfaces.map((surface) => ({
    type: 'replace',
    hostId: surface.hostId,
    request: {
      hostId: surface.hostId,
      workspaceId: surface.workspaceId,
      hostTabId: surface.hostTabId,
      expected: { occurrence: surface.occurrence, revision: surface.revision },
      content: null,
      callerId: 'deregistered-repository',
      commandId: randomUUID(),
      expiresAt: Date.now() + 60_000
    }
  }))
}

export function assertOrphanRetirementsAccepted(results: readonly SurfaceStorageResult[]): void {
  if (
    results.some(
      ({ outcome }) =>
        !outcome ||
        typeof outcome !== 'object' ||
        !('status' in outcome) ||
        outcome.status !== 'accepted'
    )
  ) {
    throw new Error('Workspace ownership changed while removing saved project residue')
  }
}
