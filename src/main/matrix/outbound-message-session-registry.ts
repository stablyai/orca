// Tracks which Orca session each OUTBOUND room message belongs to, keyed by the
// Matrix event id of that message. The inbound router uses this so an operator
// REPLY (m.in_reply_to) to one of the relay's messages routes back to the right
// session without the operator having to type `@<handle>`.
//
// In-memory only: replies are to recent messages, so persistence buys nothing,
// and a fresh map after a restart just falls back to the `@<handle>` path.
// Bounded so a long-lived process can't leak — oldest entries evict first
// (insertion order is FIFO; a Map preserves it).

// Cap chosen so the room's recent history is always covered while keeping the
// map's footprint trivial. Replies target recent messages, so evicting the
// oldest beyond this never loses a reply target in practice.
const MAX_ENTRIES = 2000

const eventToPaneKey = new Map<string, string>()

// Records that an outbound room message (eventId) belongs to a session (paneKey).
// Re-recording the same eventId refreshes it to most-recent. Evicts the oldest
// entry once the map exceeds the cap so it stays bounded.
export function recordOutboundMessage(eventId: string, paneKey: string): void {
  // Defensive: never key on an empty/missing id. Callers only record after a
  // successful send (eventId is a real string), but guard so a malformed id can
  // never poison the map or its eviction.
  if (!eventId) {
    return
  }
  // Delete-then-set so a repeat eventId moves to the end (most-recent), keeping
  // eviction honest about recency.
  if (eventToPaneKey.has(eventId)) {
    eventToPaneKey.delete(eventId)
  }
  eventToPaneKey.set(eventId, paneKey)
  if (eventToPaneKey.size > MAX_ENTRIES) {
    const oldest = eventToPaneKey.keys().next().value
    if (oldest !== undefined) {
      eventToPaneKey.delete(oldest)
    }
  }
}

// Resolves the session a reply targets, or null if the replied-to event isn't a
// known outbound relay message (e.g. an ordinary room message, or one evicted by
// age — in which case the caller falls back to `@<handle>` parsing).
export function paneKeyForOutboundEvent(eventId: string): string | null {
  return eventToPaneKey.get(eventId) ?? null
}

// Testing seam: clears the registry between tests.
export function resetOutboundMessageRegistryForTests(): void {
  eventToPaneKey.clear()
}
