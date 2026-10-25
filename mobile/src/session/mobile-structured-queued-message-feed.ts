// The host publishes its queued drafts whole-list on the subscribe stream:
// present = the current list, absent = unchanged since the last frame this
// subscriber was sent, `null` = empty. History pages are ignored here — the
// live stream is authoritative and a stale history answer must never replace
// a newer live list.

import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'

/** Null = no claim yet (older host, or nothing published on this stream). */
export type MobileQueuedMessageFeed = AgentSessionQueuedMessage[] | null

/** The whole queue's pause; null when it sends on its own or nothing was published. */
export type MobileQueuePause = AgentSessionQueuePause | null

/** The pause rides with the list: a frame that publishes the list states it, and one that omits
 *  the list leaves it unchanged. */
export function reduceMobileQueuePause(
  previous: MobileQueuePause,
  event: AgentSessionSubscribeEvent
): MobileQueuePause {
  if (event.type === 'end' || event.queuedMessages === undefined) {
    return previous
  }
  const next = event.queuePause ?? null
  // Presence first: a pause with no reason, or one this build does not know, is still a pause.
  if ((next === null) !== (previous === null)) {
    return next
  }
  return next?.reason === previous?.reason ? previous : next
}

export function reduceMobileQueuedMessageFeed(
  previous: MobileQueuedMessageFeed,
  event: AgentSessionSubscribeEvent
): MobileQueuedMessageFeed {
  if (event.type === 'end') {
    return previous
  }
  if (event.queuedMessages === undefined) {
    return previous
  }
  const list = event.queuedMessages ?? []
  if (list.length === 0 && previous !== null && previous.length === 0) {
    return previous
  }
  // Host order is authoritative; sort defensively so card order never depends
  // on publication order.
  return [...list].sort((left, right) => left.position - right.position)
}
