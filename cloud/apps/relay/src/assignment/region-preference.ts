import type { RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { RelayDatabase } from '../database.js'

// The region a host last asked for (relay_assignment_region_preferences); an older observation
// never overwrites a newer one. Written by the cell path and the relay edge's moves.
export async function recordRegionPreference(
  database: RelayDatabase,
  identity: { userId: string; relayHostId: string },
  preferredRegion: RelayRegion | undefined,
  observedAt: number
): Promise<void> {
  if (!preferredRegion) return
  await database.query(
    `INSERT INTO relay_assignment_region_preferences
     (user_id, relay_host_id, preferred_region, observed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
       preferred_region = CASE
         WHEN excluded.observed_at >= relay_assignment_region_preferences.observed_at
           THEN excluded.preferred_region
         ELSE relay_assignment_region_preferences.preferred_region
       END,
       observed_at = CASE
         WHEN excluded.observed_at >= relay_assignment_region_preferences.observed_at
           THEN excluded.observed_at
         ELSE relay_assignment_region_preferences.observed_at
       END`,
    [identity.userId, identity.relayHostId, preferredRegion, observedAt]
  )
}
