/**
 * Inserts an unpinned tab at `index` (the end when absent), never ahead of a pinned tab: the
 * client's index was chosen before the commit, and pins may have changed since.
 */
export function insertUnpinnedTab(
  tabOrder: readonly string[],
  tabId: string,
  index: number | undefined,
  pinnedTabIds: ReadonlySet<string>
): string[] {
  const order = tabOrder.filter((id) => id !== tabId)
  const firstUnpinned = order.findIndex((id) => !pinnedTabIds.has(id))
  const pinnedEnd = firstUnpinned === -1 ? order.length : firstUnpinned
  const at = Math.min(Math.max(index ?? order.length, pinnedEnd), order.length)
  return [...order.slice(0, at), tabId, ...order.slice(at)]
}
