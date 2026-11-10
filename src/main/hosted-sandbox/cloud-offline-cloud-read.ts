// The asleep view's reads of a workspace's sealed sleep snapshot (Orca Cloud), memoized: the
// snapshot only changes when the workspace wakes and sleeps again, and the view polls.
import type { ReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import type { CloudOfflineSnapshot } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { CloudOfflineCache } from './cloud-offline-cache'
import { buildOfflineSnapshot } from './cloud-offline-snapshot'
import { mergeCloudReadSnapshot } from './cloud-offline-snapshot-merge'

/** The workspace's sealed sleep snapshot opened on this device, or null (none, unreadable). */
export type CloudSnapshotReader = (workspaceId: string) => Promise<ReadSnapshot | null>

const TTL_MS = 2 * 60_000
const FAILED_TTL_MS = 30_000
/** The asleep view never waits long on the network; a slow read lands on the next poll. */
const WAIT_MS = 3_000

type Entry = { at: number; ttl: number; promise: Promise<ReadSnapshot | null> }

export function createCloudReadMemo(
  read: CloudSnapshotReader | undefined,
  options: { waitMs?: number; now?: () => number } = {}
) {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  const memo = {
    /** Resolves null (never throws) when there is none, it failed, or it is not back in time. */
    async get(workspaceId: string): Promise<ReadSnapshot | null> {
      if (!read) {
        return null
      }
      let entry = entries.get(workspaceId)
      if (!entry || now() - entry.at >= entry.ttl) {
        const fresh: Entry = {
          at: now(),
          ttl: TTL_MS,
          promise: read(workspaceId).catch(() => null)
        }
        void fresh.promise.then((value) => {
          if (value === null) {
            fresh.ttl = FAILED_TTL_MS
          }
        })
        entries.set(workspaceId, fresh)
        entry = fresh
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.waitMs ?? WAIT_MS)
      })
      try {
        return await Promise.race([entry.promise, late])
      } finally {
        clearTimeout(timer)
      }
    },
    /** Awake again: the next sleep leaves a new snapshot. */
    forget(workspaceId: string): void {
      entries.delete(workspaceId)
    },
    clear(): void {
      entries.clear()
    },
    /**
     * The asleep view: this computer's cached copy, with newer sections from the workspace's own
     * sleep snapshot while it is asleep. Any cloud failure leaves the cached copy as it was.
     */
    async snapshot(
      cache: CloudOfflineCache,
      info: { environmentId: string; asleep: boolean },
      workspaceId: string
    ): Promise<CloudOfflineSnapshot> {
      const local = await buildOfflineSnapshot(cache, info.environmentId, workspaceId, info.asleep)
      if (!info.asleep) {
        memo.forget(workspaceId)
        return local
      }
      const remote = await memo.get(workspaceId)
      return remote ? mergeCloudReadSnapshot(local, remote) : local
    }
  }
  return memo
}
