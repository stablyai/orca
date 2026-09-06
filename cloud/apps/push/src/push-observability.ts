type PushCounterName =
  | 'ip_rate_limited'
  | 'request_error'
  | 'challenge_issued'
  | 'challenge_rejected'
  | 'session_issued'
  | 'session_rejected'
  | 'device_registered'
  | 'device_rejected'
  | 'device_deleted'
  | 'send_queued'
  | 'send_dead'
  | 'send_rate_limited'
  | 'send_error'
  | 'delivery_sent'
  | 'delivery_dead'
  | 'delivery_error'

const COUNTER_NAMES: PushCounterName[] = [
  'ip_rate_limited',
  'request_error',
  'challenge_issued',
  'challenge_rejected',
  'session_issued',
  'session_rejected',
  'device_registered',
  'device_rejected',
  'device_deleted',
  'send_queued',
  'send_dead',
  'send_rate_limited',
  'send_error',
  'delivery_sent',
  'delivery_dead',
  'delivery_error'
]

// Aggregate counters only. Nothing here may accept a token, a title, a body,
// or more than the first four characters of a host fingerprint.
export class PushObservability {
  private counters = new Map<PushCounterName, number>()
  private timer: NodeJS.Timeout | null = null

  record(name: PushCounterName, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta)
  }

  consume(): Record<PushCounterName, number> {
    const snapshot = Object.fromEntries(
      COUNTER_NAMES.map((name) => [name, this.counters.get(name) ?? 0])
    ) as Record<PushCounterName, number>
    this.counters = new Map()
    return snapshot
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const counters = this.consume()
      if (Object.values(counters).every((value) => value === 0)) return
      console.warn(JSON.stringify({ event: 'orca_push_counters', ...counters }))
    }, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
