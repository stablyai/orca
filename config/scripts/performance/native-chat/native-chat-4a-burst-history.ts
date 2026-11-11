import { history } from './native-chat-4a-session'
import type { Page } from '@stablyai/playwright-test'

export const burstCallIds = (tag: string): string[] =>
  Array.from({ length: 8 }, (_, index) => `toolu_4a_${tag}_${index + 1}`)

/** Byte-bounded pages may omit completed originals from the tail; walk back by their real cursor. */
export async function completedBurst(page: Page, sessionId: string, expected: string[]) {
  const found = new Map<string, string>()
  const cursors = new Set<string>()
  let cursor: unknown
  for (let pages = 0; pages < 16; pages += 1) {
    const result = await history(page, sessionId, cursor ? 'before' : 'tail', 40, cursor)
    for (const item of result.page.items) {
      if (
        item.body?.kind === 'tool-call' &&
        item.body.callId &&
        expected.includes(item.body.callId)
      ) {
        if (item.body.state !== 'completed') {
          throw new Error(`burst ${item.body.callId} is ${item.body.state}; contention unexercised`)
        }
        found.set(item.body.callId, item.itemId)
      }
    }
    if (found.size === 8) {
      return {
        completed: found.size,
        itemIds: [...found.values()],
        callIds: [...found.keys()],
        pages: pages + 1
      }
    }
    const next = result.page.window.nextCursor
    const key = JSON.stringify(next)
    if (!result.page.hasOlder || !next || cursors.has(key)) {
      break
    }
    cursors.add(key)
    cursor = next
  }
  throw new Error(
    `burst completed ${found.size} of 8 unique calls across bounded history; unexercised`
  )
}
