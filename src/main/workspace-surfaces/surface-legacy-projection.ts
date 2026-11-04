import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceProjection } from '../../shared/workspace-surfaces/surface-profile-domain'
import { domainRevision } from './surface-rows'

export type { SurfaceProjection } from '../../shared/workspace-surfaces/surface-profile-domain'

/** Content-only comparison: old builds neither know run tokens nor own device placement. */
export function surfaceProjectionFingerprint(surfaces: readonly WorkspaceSurface[]): string {
  const contents = surfaces
    .flatMap((surface) => {
      if (!surface.content) {
        return []
      }
      const content =
        surface.content.kind === 'terminal'
          ? {
              ...surface.content,
              leaves: Object.fromEntries(
                Object.entries(surface.content.leaves).map(([id, leaf]) => [id, leaf.facts])
              )
            }
          : surface.content
      return [{ hostTabId: surface.hostTabId, content }]
    })
    .sort((a, b) => a.hostTabId.localeCompare(b.hostTabId, 'en'))
  return createHash('sha256').update(stableJson(contents)).digest('hex')
}

export function seedSurfaceProjectionBaseline(
  db: Database.Database,
  hostId: string,
  workspaceId: string,
  surfaces: readonly WorkspaceSurface[],
  mintId: () => string
): void {
  const baseline: SurfaceProjection = {
    projectionId: mintId(),
    revision: domainRevision(db, hostId),
    fingerprint: surfaceProjectionFingerprint(surfaces),
    surfaces: [...surfaces]
  }
  db.prepare(`INSERT OR IGNORE INTO main.workspace_surface_projections
    (host_id, workspace_id, baseline_json) VALUES (?, ?, ?)`).run(
    hostId,
    workspaceId,
    JSON.stringify(baseline)
  )
}
