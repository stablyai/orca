/** Where a reader left a chat: its top row, and how far past that row's top the view starts. */
export type MobileNativeChatPlace = { key: string; offset: number }

/** A restore landed, waits for its row to be drawn, or found the row gone. */
export type MobileNativeChatRestore = 'restored' | 'pending' | 'missing'

const LIMIT = 64
// Module scope: a chat view remounted for a reload or a return to the session keeps its places.
const places = new Map<string, MobileNativeChatPlace>()

/** Remembers a chat left away from its tail; null forgets it, so the chat reopens following. */
export function saveMobileNativeChatPlace(
  scope: string,
  place: MobileNativeChatPlace | null
): void {
  places.delete(scope)
  if (!place) {
    return
  }
  places.set(scope, place)
  if (places.size > LIMIT) {
    const oldest = places.keys().next()
    if (!oldest.done) {
      places.delete(oldest.value)
    }
  }
}

export function savedMobileNativeChatPlace(scope: string): MobileNativeChatPlace | undefined {
  return places.get(scope)
}
