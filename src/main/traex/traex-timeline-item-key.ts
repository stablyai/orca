export function traexTimelineItemKey(turnId: string, itemId: string): string {
  return JSON.stringify([turnId, itemId])
}
