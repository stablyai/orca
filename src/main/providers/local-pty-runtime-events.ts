// Object identity survives provider forwarding without adding fields to the wire contract.
const deliveredEvents = new WeakSet<object>()

export function markLocalRuntimeDelivered<T extends object>(event: T): T {
  deliveredEvents.add(event)
  return event
}

export function wasLocalRuntimeDelivered(event: object): boolean {
  return deliveredEvents.has(event)
}
