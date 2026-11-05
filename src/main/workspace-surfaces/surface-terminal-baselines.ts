import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type Database from '../sqlite/sync-database'
import { isDeepStrictEqual } from 'node:util'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { surfaceProjectionFingerprint } from './surface-legacy-projection'
import { recordSurfaceBaseline } from './surface-transaction-changes'

export function updateTerminalBaselines(
  db: Database.Database,
  domain: SurfaceProfileDomain,
  hostId: string,
  mintId: () => string,
  affectedWorkspaces?: ReadonlySet<string>
): void {
  const host = domain.hosts[hostId]!
  const grouped = new Map<string, WorkspaceSurface[]>()
  for (const surface of host.surfaces) {
    if (surface.content?.kind !== 'terminal') {
      continue
    }
    const group = grouped.get(surface.workspaceId) ?? []
    group.push(surface)
    grouped.set(surface.workspaceId, group)
  }
  const workspaces = new Set([...Object.keys(host.terminalBaselines), ...grouped.keys()])
  for (const workspaceId of workspaces) {
    if (affectedWorkspaces && !affectedWorkspaces.has(workspaceId)) {
      continue
    }
    const surfaces = grouped.get(workspaceId) ?? []
    if (surfaces.length === 0) {
      delete host.terminalBaselines[workspaceId]
      db.prepare(
        'DELETE FROM main.workspace_surface_projections WHERE host_id = ? AND workspace_id = ?'
      ).run(hostId, workspaceId)
      recordSurfaceBaseline(db, hostId, workspaceId, null)
      continue
    }
    if (isDeepStrictEqual(host.terminalBaselines[workspaceId]?.surfaces, surfaces)) {
      continue
    }
    const baseline = {
      projectionId: mintId(),
      revision: host.revision,
      fingerprint: surfaceProjectionFingerprint(surfaces),
      surfaces
    }
    host.terminalBaselines[workspaceId] = baseline
    recordSurfaceBaseline(db, hostId, workspaceId, baseline)
    db.prepare(`INSERT INTO main.workspace_surface_projections(host_id, workspace_id, baseline_json)
      VALUES (?, ?, ?) ON CONFLICT(host_id, workspace_id) DO UPDATE SET baseline_json = excluded.baseline_json`).run(
      hostId,
      workspaceId,
      JSON.stringify(baseline)
    )
  }
}
