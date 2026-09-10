import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'

export type CachedPaneEnvelopeMeta = { source: AgentHookSource; env?: string; version?: string }

export type CachedPaneReplaySelection = {
  event: AgentHookEventPayload
  meta: CachedPaneEnvelopeMeta
}

/**
 * Chooses which cached pane statuses a reconnecting client may be re-told about, and drops the rest.
 *
 * Two panes are refused, for opposite reasons:
 * - a pane whose surface has been retired — the tab is gone, so replaying its status would hand the
 *   client a live agent pane nobody owns, which is what drives an auto-resume onto a transcript an
 *   orphaned agent is still writing;
 * - a pane whose envelope metadata is missing — the status cache and the metadata map are populated
 *   and cleared in lockstep, so a key present in one and not the other is drift. Skip rather than
 *   guess a source that mis-tags the replay downstream.
 */
export function selectReplayableCachedPanes(input: {
  cachedByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  metaByPaneKey: ReadonlyMap<string, CachedPaneEnvelopeMeta>
  isPaneSurfaceRetired: (paneKey: string) => boolean
  dropPane: (paneKey: string) => void
}): CachedPaneReplaySelection[] {
  const selected: CachedPaneReplaySelection[] = []
  // Snapshot: dropping a retired pane mutates the map being read.
  for (const [paneKey, event] of Array.from(input.cachedByPaneKey.entries())) {
    if (input.isPaneSurfaceRetired(paneKey)) {
      input.dropPane(paneKey)
      continue
    }
    const meta = input.metaByPaneKey.get(paneKey)
    if (meta) {
      selected.push({ event, meta })
    }
  }
  return selected
}

/** How many panes keep a cached status. Bounds a long-lived relay's per-pane state. */
export const MAX_CACHED_PANES = 256

/** Drop the longest-idle panes until the cache is back under its cap. Map insertion order is
 *  recency (writers delete-then-set), so the first key is always the oldest. */
export function evictCachedPanesOverCap(
  cachedByPaneKey: ReadonlyMap<string, unknown>,
  dropPane: (paneKey: string) => void,
  maxPanes: number = MAX_CACHED_PANES
): void {
  while (cachedByPaneKey.size > maxPanes) {
    const oldest = cachedByPaneKey.keys().next().value
    if (oldest === undefined) {
      return
    }
    dropPane(oldest)
  }
}
