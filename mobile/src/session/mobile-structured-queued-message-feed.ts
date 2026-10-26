// Live lists are authoritative: absent means unchanged and null means empty; history pages must never replace newer queue state.

import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'

/** Null = no claim yet (older host, or nothing published on this stream). */
export type MobileQueuedMessageFeed = AgentSessionQueuedMessage[] | null

/** The whole queue's pause; null when it sends on its own or nothing was published. */
export type MobileQueuePause = AgentSessionQueuePause | null

// List and pause publish together; omitted lists preserve both.
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
  // Use host positions so publication order cannot reorder cards.
  return [...list].sort((left, right) => left.position - right.position)
}
