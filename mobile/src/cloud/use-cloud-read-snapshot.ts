import { useQuery } from '@tanstack/react-query'
import { readCloudWorkspaceSnapshot, type CloudReadSnapshotResult } from './cloud-read-snapshot'
import {
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'

/**
 * The sleeping workspace's read-only snapshot, fetched only while it is asleep and never waking it.
 * Keyed by `readSnapshotAt`, so a newer sleep refetches; kept in memory only (never persisted).
 */
export function useCloudReadSnapshot(
  sandboxId: string,
  asleep: boolean,
  readSnapshotAt: number | null
) {
  const removal = useCloudHostRemoval()
  return useQuery<CloudReadSnapshotResult>({
    queryKey: ['orca-cloud', 'read-snapshot', sandboxId, readSnapshotAt],
    enabled: asleep,
    queryFn: async ({ signal }) => {
      const plane = await loadCloudControlPlane()
      if (!plane) {
        return { state: 'error', error: new Error('not_enrolled') }
      }
      const result = await readCloudWorkspaceSnapshot(plane, sandboxId, { signal })
      if (result.state === 'error') {
        await forgetRevokedCloudSession(result.error, removal)
      }
      return result
    },
    // A snapshot only changes when the workspace sleeps again, which changes the key above.
    staleTime: 5 * 60_000,
    gcTime: 60_000,
    retry: false
  })
}
