import { randomUUID } from 'node:crypto'
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
export type StoredPlacementCatalog = { version: string; value: RetainedPlacementCatalog }
const storedSchema = WorkerPlacementCatalogSchema.extend({ version: z.string().default('legacy') })
const storedVersion = "COALESCE(json_extract(catalog_json, '$.version'), 'legacy')"

export function readRetainedPlacementCatalog(
  db: OrchestrationDb,
  pin: RemoteServerPin
): StoredPlacementCatalog | undefined {
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
  const { version, ...catalog } = storedSchema.parse(JSON.parse(row.catalog_json))
  return { version, value: { observedAt: row.observed_at, catalog } }
}

export function writeRetainedPlacementCatalog(
  db: OrchestrationDb,
  pin: RemoteServerPin,
  previousVersion: string | null,
  value: RetainedPlacementCatalog
): StoredPlacementCatalog | undefined {
  // A completed read replaces only its predecessor, even across clock rollbacks and deletion/reinsertion.
  const version = randomUUID()
  const result = db.db
    .prepare(`INSERT OR REPLACE INTO worker_placement_catalogs
    (environment_id, peer_fingerprint, home_fingerprint, pairing_revision, observed_at, catalog_json)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE (SELECT ${storedVersion} FROM worker_placement_catalogs WHERE environment_id = ?) IS ?
  `)
    .run(
      pin.environment_id,
      pin.peer_fingerprint,
      pin.home_fingerprint,
      pin.pairing_revision,
      value.observedAt,
      JSON.stringify({ version, ...value.catalog }),
      pin.environment_id,
      previousVersion
    )
  return result.changes === 1 ? { version, value } : undefined
}

export function deleteRetainedPlacementCatalog(
  db: OrchestrationDb,
  environmentId: string,
  expectedVersion?: string | null
): void {
  if (expectedVersion === undefined) {
    db.db
      .prepare('DELETE FROM worker_placement_catalogs WHERE environment_id = ?')
      .run(environmentId)
  } else {
    db.db
      .prepare(
        `DELETE FROM worker_placement_catalogs WHERE environment_id = ? AND ${storedVersion} = ?`
      )
      .run(environmentId, expectedVersion)
  }
}
