import type Database from '../sqlite/sync-database'
import { isDeepStrictEqual } from 'node:util'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { surfaceProjectionFingerprint } from './surface-legacy-projection'

export function updateTerminalBaselines(
  db: Database.Database,
  domain: SurfaceProfileDomain,
  hostId: string,
  mintId: () => string
): void {
  const host = domain.hosts[hostId]!
  const workspaces = new Set([
    ...Object.keys(host.terminalBaselines),
    ...host.surfaces.map((surface) => surface.workspaceId)
  ])
  for (const workspaceId of workspaces) {
    const surfaces = host.surfaces.filter(
      (surface) => surface.workspaceId === workspaceId && surface.content?.kind === 'terminal'
    )
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
    db.prepare(`INSERT INTO main.workspace_surface_projections(host_id, workspace_id, baseline_json)
      VALUES (?, ?, ?) ON CONFLICT(host_id, workspace_id) DO UPDATE SET baseline_json = excluded.baseline_json`).run(
      hostId,
      workspaceId,
      JSON.stringify(baseline)
    )
  }
}
