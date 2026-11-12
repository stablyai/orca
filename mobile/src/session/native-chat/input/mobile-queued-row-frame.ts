import type { LayoutRectangle } from 'react-native'

/** Where a row sits in the queue's scroll content: rows stack in order, so it starts below those before it. */
export function queuedRowFrame(
  messageIds: readonly string[],
  heights: ReadonlyMap<string, number>,
  targetId: string | null
): LayoutRectangle | null {
  const index = targetId === null ? -1 : messageIds.indexOf(targetId)
  if (index === -1) {
    return null
  }
  let top = 0
  for (const [at, messageId] of messageIds.entries()) {
    const height = heights.get(messageId)
    // Not every row has laid out yet.
    if (height === undefined) {
      return null
    }
    if (at === index) {
      return { x: 0, y: top, width: 0, height }
    }
    top += height
  }
  return null
}
