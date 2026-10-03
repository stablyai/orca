import type { DeviceScope } from '../../shared/runtime-session-contracts'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'

/**
 * Metadata-only pairing and connection events for unattended servers (orcad), so an operator can
 * see who paired, who connected and what was refused. Off unless a host enables it; the desktop
 * app never does. Tokens, pairing links and keys are never part of an event.
 */
export const SECURITY_EVENT_PREFIX = 'ORCA_SECURITY_EVENT '

const WINDOW_MS = 60_000

/** Why two budgets: refusals are attacker-driven, so a rejection flood must not starve operator events. */
const GROUPS = ['rejections', 'operator'] as const

type Group = (typeof GROUPS)[number]

export type SecurityEvent =
  | {
      event: 'pairing_offer_issued'
      deviceId: string
      scope: DeviceScope
      reach: RuntimePairingReach
      /** Unused pending offers this issue invalidated (rotation). */
      invalidatedPending: number
    }
  | { event: 'device_paired'; deviceId: string; scope: DeviceScope }
  | { event: 'device_removed'; deviceId: string; scope: DeviceScope }
  | {
      event: 'connection_accepted'
      deviceId: string
      scope: DeviceScope
      transport: 'direct' | 'relay'
    }
  | { event: 'connection_rejected'; transport: 'direct' | 'relay'; code: number; reason: string }

type Budget = {
  limitPerMinute: number
  windowStart: number
  inWindow: number
  suppressed: number
  /** Armed by the first drop of a window so the tail is reported even if no further event arrives. */
  flushTimer: ReturnType<typeof setTimeout> | null
}

type Sink = {
  write: (line: string) => void
  now: () => number
  budgets: Record<Group, Budget>
}

let sink: Sink | null = null

export function enableSecurityEventLog(options: {
  write: (line: string) => void
  now?: () => number
  limitPerMinute?: number
}): void {
  // Why: reap a previous sink's pending timer so it cannot write into a window it no longer owns.
  disableSecurityEventLog()
  const now = options.now ?? Date.now
  const windowStart = now()
  const limitPerMinute = options.limitPerMinute ?? 60
  sink = {
    write: options.write,
    now,
    budgets: {
      rejections: { limitPerMinute, windowStart, inWindow: 0, suppressed: 0, flushTimer: null },
      operator: { limitPerMinute, windowStart, inWindow: 0, suppressed: 0, flushTimer: null }
    }
  }
}

export function disableSecurityEventLog(): void {
  if (!sink) {
    return
  }
  // Why: the operator still wants the last window's drops; dropping the sink would lose them.
  flushWindows(sink, sink.now())
  sink = null
}

export function recordSecurityEvent(event: SecurityEvent): void {
  if (!sink) {
    return
  }
  const ts = sink.now()
  const group: Group = event.event === 'connection_rejected' ? 'rejections' : 'operator'
  const budget = sink.budgets[group]
  if (ts - budget.windowStart >= WINDOW_MS) {
    flushWindow(sink, budget, group, ts)
  }
  // Why a cap: refused connections are attacker-driven, and the journal must not become the DoS.
  if (budget.inWindow >= budget.limitPerMinute) {
    budget.suppressed += 1
    armFlush(sink, budget, group)
    return
  }
  budget.inWindow += 1
  emit(sink, { ...event, ts })
}

function flushWindows(target: Sink, ts: number): void {
  for (const group of GROUPS) {
    flushWindow(target, target.budgets[group], group, ts)
  }
}

function flushWindow(target: Sink, budget: Budget, group: Group, ts: number): void {
  if (budget.flushTimer) {
    clearTimeout(budget.flushTimer)
    budget.flushTimer = null
  }
  if (budget.suppressed > 0) {
    emit(target, { event: 'events_suppressed', group, count: budget.suppressed, ts })
  }
  budget.windowStart = ts
  budget.inWindow = 0
  budget.suppressed = 0
}

// Why: a window that ends in silence still owes the operator the count it dropped.
function armFlush(target: Sink, budget: Budget, group: Group): void {
  if (budget.flushTimer) {
    return
  }
  const timer = setTimeout(
    () => {
      budget.flushTimer = null
      flushWindow(target, budget, group, target.now())
    },
    Math.max(0, budget.windowStart + WINDOW_MS - target.now())
  )
  budget.flushTimer = timer
  // Why unref: a pending flush must never hold the orcad process open. Guarded: test fake timers have none.
  if (typeof timer.unref === 'function') {
    timer.unref()
  }
}

function emit(target: Sink, record: object): void {
  try {
    target.write(`${SECURITY_EVENT_PREFIX}${JSON.stringify(record)}`)
  } catch {
    // Why swallow: security telemetry must never break pairing or connections.
  }
}
