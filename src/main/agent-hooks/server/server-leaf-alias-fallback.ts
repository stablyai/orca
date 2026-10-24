import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

/**
 * Returns the one live tab (other than the given one) that holds the leaf, or null. Leaf ids are
 * UUIDs, so a leaf found in another live tab is the same pane, moved.
 */
export type LiveLeafOwnerResolver = (tabId: string, leafId: string) => string | null

/** The stable pane key for a key that has no alias, or null when no live tab holds its leaf. */
export function resolveLeafAliasFallback(
  paneKey: string,
  resolveOwner: LiveLeafOwnerResolver | null
): string | null {
  const parsed = resolveOwner ? parsePaneKey(paneKey) : null
  if (!resolveOwner || !parsed) {
    return null
  }
  const ownerTabId = resolveOwner(parsed.tabId, parsed.leafId)
  return ownerTabId && ownerTabId !== parsed.tabId ? makePaneKey(ownerTabId, parsed.leafId) : null
}
