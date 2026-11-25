/**
 * Inserts an unpinned tab at `index` (the end when absent), never ahead of any pinned tab: pins
 * need not form a prefix of the order, and the client's index was chosen before the commit.
 */
export function insertUnpinnedTab(
  tabOrder: readonly string[],
  tabId: string,
  index: number | undefined,
  pinnedTabIds: ReadonlySet<string>
): string[] {
  const order = tabOrder.filter((id) => id !== tabId)
  let afterLastPin = 0
  order.forEach((id, at) => {
    if (pinnedTabIds.has(id)) {
      afterLastPin = at + 1
    }
  })
  const at = Math.min(Math.max(index ?? order.length, afterLastPin), order.length)
  return [...order.slice(0, at), tabId, ...order.slice(at)]
}
