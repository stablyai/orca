/**
 * What a reply owns until its bytes have actually left: an admitted consumer and any image it
 * holds, and optionally the full line already encoded with the existing encoder. It travels to
 * the outer writer beside the route's value and never enters the wire payload.
 */
export type PreparedDaemonReply = {
  /** The complete `{id, ok, payload}` line; written as-is, never encoded again. */
  readonly line?: string
  release(): void
}

const prepared = new WeakMap<object, PreparedDaemonReply>()

export function withPreparedReply<T extends object>(value: T, reply: PreparedDaemonReply): T {
  prepared.set(value, reply)
  return value
}

export function takePreparedReply(value: unknown): PreparedDaemonReply | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const reply = prepared.get(value)
  prepared.delete(value)
  return reply
}
