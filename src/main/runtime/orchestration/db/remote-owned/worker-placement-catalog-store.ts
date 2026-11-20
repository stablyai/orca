import { z } from 'zod'
import { WorkerPlacementCatalogSchema } from '../../federation/placement/worker-placement-catalog'
import type { OrchestrationDb } from '../orchestration-db'
import { remoteRunLinkPinMatches, type RemoteServerPin } from './remote-run-links'
import type { WorkerPlacementCatalog } from '../../federation/placement/worker-placement-catalog'

export const WORKER_PLACEMENT_CATALOG_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS worker_placement_catalogs (
    environment_id TEXT PRIMARY KEY,
    peer_fingerprint TEXT NOT NULL,
    home_fingerprint TEXT NOT NULL,
    pairing_revision INTEGER,
    observed_at INTEGER NOT NULL,
    catalog_json TEXT NOT NULL
  );
`
export type RetainedPlacementCatalog = { observedAt: number; catalog: WorkerPlacementCatalog }

export function readRetainedPlacementCatalog(
  db: OrchestrationDb,
  pin: RemoteServerPin
): RetainedPlacementCatalog | undefined {
  const row = z
    .object({
      environment_id: z.string(),
      peer_fingerprint: z.string(),
      home_fingerprint: z.string(),
      pairing_revision: z.number().nullable(),
      observed_at: z.number(),
      catalog_json: z.string()
    })
    .optional()
    .parse(
      db.db
        .prepare('SELECT * FROM worker_placement_catalogs WHERE environment_id = ?')
        .get(pin.environment_id)
    )
  if (!row) {
    return undefined
  }
  if (!remoteRunLinkPinMatches(row, pin)) {
    deleteRetainedPlacementCatalog(db, pin.environment_id)
    return undefined
  }
  return {
    observedAt: row.observed_at,
    catalog: WorkerPlacementCatalogSchema.parse(JSON.parse(row.catalog_json))
  }
}

export function writeRetainedPlacementCatalog(
  db: OrchestrationDb,
  pin: RemoteServerPin,
  value: RetainedPlacementCatalog
): void {
  db.db
    .prepare(`INSERT INTO worker_placement_catalogs
    (environment_id, peer_fingerprint, home_fingerprint, pairing_revision, observed_at, catalog_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(environment_id) DO UPDATE SET
      peer_fingerprint = excluded.peer_fingerprint, home_fingerprint = excluded.home_fingerprint,
      pairing_revision = excluded.pairing_revision, observed_at = excluded.observed_at,
      catalog_json = excluded.catalog_json
    WHERE excluded.observed_at > worker_placement_catalogs.observed_at
  `)
    .run(
      pin.environment_id,
      pin.peer_fingerprint,
      pin.home_fingerprint,
      pin.pairing_revision,
      value.observedAt,
      JSON.stringify(value.catalog)
    )
}

export function deleteRetainedPlacementCatalog(db: OrchestrationDb, environmentId: string): void {
  db.db.prepare('DELETE FROM worker_placement_catalogs WHERE environment_id = ?').run(environmentId)
}
