/**
 * Terminal names for a remote host's Resource Manager rows.
 *
 * A remote snapshot identifies its sessions by pty id only, so the panel would
 * otherwise label them `pid <n>`. The host already knows the names — they come
 * back from `terminal.list` — so this fetches that list and maps pty id → title.
 *
 * Two constraints shape it. The panel polls every two seconds, and titles change
 * far more slowly than usage does, so results are cached per host rather than
 * re-fetched on every tick. And a host that cannot answer must cost the labels
 * only: every failure resolves to an empty map, never a thrown snapshot.
 */

import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

// Why: long enough that a 2s poll almost always reads cache, short enough that a
// rename shows up while the panel is still open.
const TITLE_CACHE_TTL_MS = 15_000
// Why: shorter than a snapshot's own deadline — titles are a nicety, and a slow
// host must not hold up usage numbers that already arrived.
const TITLE_REQUEST_TIMEOUT_MS = 5_000
// Why: bound the reply on a host running a lot of terminals; the panel only needs
// names for the sessions a snapshot actually lists.
const TITLE_REQUEST_LIMIT = 200

type CacheEntry = {
  titles: ReadonlyMap<string, string>
  expiresAt: number
}

const cacheByEnvironmentId = new Map<string, CacheEntry>()
const inflightByEnvironmentId = new Map<string, Promise<ReadonlyMap<string, string>>>()

function titlesFromResult(value: unknown): ReadonlyMap<string, string> {
  const terminals = (value as { terminals?: unknown } | null)?.terminals
  if (!Array.isArray(terminals)) {
    return new Map()
  }
  const titles = new Map<string, string>()
  for (const entry of terminals as RuntimeTerminalSummary[]) {
    const ptyId = typeof entry?.ptyId === 'string' ? entry.ptyId : ''
    const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
    if (ptyId && title) {
      titles.set(ptyId, title)
    }
  }
  return titles
}

async function requestTitles(
  userDataPath: string,
  environmentId: string
): Promise<ReadonlyMap<string, string>> {
  try {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'terminal.list',
      {
        limit: TITLE_REQUEST_LIMIT,
        // Why: layouts are a large share of the payload and nothing here reads them.
        includeVisualLayouts: false,
        // Why: naming a row must never trigger liveness probes on the far side.
        requireFreshPtyLiveness: false
      },
      TITLE_REQUEST_TIMEOUT_MS
    )
    return response.ok ? titlesFromResult(response.result) : new Map()
  } catch {
    // Why: an unreachable or older host simply has no names to offer. The snapshot
    // is already in hand, so this degrades to the pid labels rather than failing.
    return new Map()
  }
}

/** Cached pty id → title for one host. Never rejects. */
export async function getRemoteTerminalTitles(
  userDataPath: string,
  environmentId: string,
  now: number = Date.now()
): Promise<ReadonlyMap<string, string>> {
  const cached = cacheByEnvironmentId.get(environmentId)
  if (cached && cached.expiresAt > now) {
    return cached.titles
  }
  const inflight = inflightByEnvironmentId.get(environmentId)
  if (inflight) {
    return inflight
  }
  const request = requestTitles(userDataPath, environmentId)
    .then((titles) => {
      // Why: cache even an empty result, so a host that cannot answer is asked
      // once per TTL instead of on every poll.
      cacheByEnvironmentId.set(environmentId, { titles, expiresAt: now + TITLE_CACHE_TTL_MS })
      return titles
    })
    .finally(() => {
      if (inflightByEnvironmentId.get(environmentId) === request) {
        inflightByEnvironmentId.delete(environmentId)
      }
    })
  inflightByEnvironmentId.set(environmentId, request)
  return request
}

/** Exported for tests; also lets a re-pair drop names from the previous runtime. */
export function clearRemoteTerminalTitleCache(environmentId?: string): void {
  if (environmentId) {
    cacheByEnvironmentId.delete(environmentId)
    inflightByEnvironmentId.delete(environmentId)
    return
  }
  cacheByEnvironmentId.clear()
  inflightByEnvironmentId.clear()
}
