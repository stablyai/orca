// ENV-BUILD-CHURN (d): a golden built from a manifest with a higher `securityLevel` carries a fix every
// environment must get. An environment build that started from a golden below the highest level in its
// region is "below the floor": the refresh rebuilds it whatever its use or last refresh, and no create
// boots from it (lifecycle.ts boots the current golden and clones instead, plus one rebuild).

/** The highest security level among the region's usable goldens; 0 when none declares one. */
export async function securityFloor(db: D1Database, region: string): Promise<number> {
  const row = await db
    .prepare(`SELECT max(security_level) AS level FROM golden_images WHERE region = ? AND status IN ('active', 'retired')`)
    .bind(region)
    .first<{ level: number | null }>()
  return row?.level ?? 0
}

/** The security level of the golden a build started from; 0 when that golden is unknown. */
export async function buildSecurityLevel(db: D1Database, baseSnapshotId: string | null): Promise<number> {
  if (!baseSnapshotId) {
    return 0
  }
  const row = await db
    .prepare('SELECT security_level AS level FROM golden_images WHERE snapshot_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(baseSnapshotId)
    .first<{ level: number | null }>()
  return row?.level ?? 0
}

/** True when the build's golden is below the highest security level in its region. */
export async function belowSecurityFloor(
  db: D1Database,
  build: { baseSnapshotId: string | null; region: string }
): Promise<boolean> {
  const floor = await securityFloor(db, build.region)
  return floor > 0 && (await buildSecurityLevel(db, build.baseSnapshotId)) < floor
}
