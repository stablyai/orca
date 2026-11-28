import {
  createHostPRCache,
  HOST_PR_BACKFILL_TTL_MS,
  readHostPRForBackfill,
  type HostPRBackfillRuntime,
  type HostPRCache
} from '../../github/pull-requests/refresh/host-pr-cache-backfill'
import {
  hostPRCacheKey,
  type HostPRCacheStore
} from '../../github/pull-requests/refresh/host-pr-cache-recording'
import { noteMainRecordedPREntry } from '../../github/pull-requests/refresh/main-recorded-pr-entries'

const backfills = new WeakMap<HostPRCacheStore, HostPRCache>()

/** Desktop has no host PR cache (the renderer refreshes visible rows only), so cleanup keeps its own. */
export function workspaceCleanupPRBackfill(
  store: HostPRCacheStore,
  runtime: HostPRBackfillRuntime
): HostPRCache {
  let backfill = backfills.get(store)
  if (!backfill) {
    backfill = createWorkspaceCleanupPRBackfill(store, runtime)
    backfills.set(store, backfill)
  }
  return backfill
}

export function createWorkspaceCleanupPRBackfill(
  store: HostPRCacheStore,
  runtime: HostPRBackfillRuntime,
  now: () => number = Date.now
): HostPRCache {
  const cache: HostPRCache = createHostPRCache({
    store,
    listWorktrees: () => runtime.listHostPRCacheWorktrees(),
    // Desktop's served reads record nothing, so the backfill records its own answers.
    readPR: async (repo, branch, linkedPR, head, signal) => {
      const outcome = await readHostPRForBackfill(runtime, repo, branch, linkedPR, head, signal)
      const before = store.getGitHubCache()
      cache.record(repo, branch, outcome, { linkedPRNumber: linkedPR, currentHeadOid: head })
      const after = store.getGitHubCache()
      const key = hostPRCacheKey(repo, branch)
      const entry = key ? after.pr[key] : undefined
      if (key && entry && after !== before) {
        noteMainRecordedPREntry(key, entry.fetchedAt, now() + HOST_PR_BACKFILL_TTL_MS)
      }
    },
    now
  })
  return cache
}
