// Which provider snapshots something live may still boot from. Every path that deletes a snapshot it
// does not exclusively own (a retired golden image, an environment build, a sweep) asks here first,
// so a delete never pulls an image out from under a workspace, a warm-pool VM or a golden image.
//
// A snapshot is in use when it is:
//   - a golden image that is not failed/deleted (active, smoking, building, or kept as a rollback),
//     or one of the config's golden ids (GOLDEN_SNAPSHOT_ID, a preview's override);
//   - the boot image of a warm-pool VM;
//   - the active build of an environment that still exists;
//   - one of a live workspace's own recorded snapshots;
//   - the boot image (source_snapshot_id) of a live workspace that has no snapshot of its own yet.
//     Once a persistent sandbox has stopped once it resumes from its own snapshot, so its source
//     image no longer pins it (environment builds would otherwise be held for every workspace's life).
// "Live" = any workspace row not yet destroyed (creating, failed and destroying rows included).

export type SnapshotRefConfig = { goldenSnapshotId: string; goldenSnapshots?: Record<string, string> }

const CHUNK = 50

/** The subset of `ids` something live still references. */
export async function snapshotsInUse(
  db: D1Database,
  config: SnapshotRefConfig,
  ids: readonly string[],
  options: { ignoreGoldenRows?: readonly string[] } = {}
): Promise<Set<string>> {
  const used = new Set<string>()
  const configGoldens = new Set([config.goldenSnapshotId, ...Object.values(config.goldenSnapshots ?? {})].filter(Boolean))
  const unique = [...new Set(ids)]
  for (const id of unique) {
    if (configGoldens.has(id)) {
      used.add(id)
    }
  }
  const ignored = options.ignoreGoldenRows ?? []
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const marks = chunk.map(() => '?').join(', ')
    const ignoreMarks = ignored.map(() => '?').join(', ')
    const queries = [
      db
        .prepare(
          `SELECT snapshot_id AS id FROM golden_images WHERE snapshot_id IN (${marks})
             AND status NOT IN ('failed', 'deleted')${ignored.length > 0 ? ` AND id NOT IN (${ignoreMarks})` : ''}`
        )
        .bind(...chunk, ...ignored),
      db.prepare(`SELECT snapshot_id AS id FROM sandbox_pool WHERE snapshot_id IN (${marks})`).bind(...chunk),
      db
        .prepare(
          `SELECT b.snapshot_id AS id FROM environments e JOIN environment_builds b ON b.id = e.active_build_id
             WHERE e.deleted_at IS NULL AND b.snapshot_id IN (${marks})`
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT ss.snapshot_id AS id FROM sandbox_snapshots ss JOIN sandboxes s ON s.id = ss.sandbox_id
             WHERE ss.deleted_at IS NULL AND s.status <> 'destroyed' AND ss.snapshot_id IN (${marks})`
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT s.source_snapshot_id AS id FROM sandboxes s
             WHERE s.status <> 'destroyed' AND s.source_snapshot_id IN (${marks})
               AND NOT EXISTS (SELECT 1 FROM sandbox_snapshots ss WHERE ss.sandbox_id = s.id AND ss.deleted_at IS NULL)`
        )
        .bind(...chunk)
    ]
    for (const query of queries) {
      for (const row of (await query.all<{ id: string }>()).results) {
        used.add(row.id)
      }
    }
  }
  return used
}
