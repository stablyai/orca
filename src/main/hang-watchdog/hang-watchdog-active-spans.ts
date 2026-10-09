import type { SpanLifecycleObserver } from '../observability/span-lifecycle'

// Only fixed operation names cross the thread boundary; attributes and dynamic names stay out.
const OPERATION_NAMES = [
  'git.exec',
  'secure-path.windows-acl',
  'persistence.terminal-topology',
  'persistence.pty-binding',
  'worktree.create',
  'worktree.remove',
  'worktree.clone',
  'worktree.checkout',
  'worktree.install',
  'agentSession.create',
  'agentSession.startup',
  'aiVault.scan',
  'aiVault.scan.service',
  'repo.ref_maintenance'
] as const

export const HANG_WATCHDOG_SPAN_CAPACITY = 64
export const HANG_WATCHDOG_SPAN_BUFFER_BYTES = (HANG_WATCHDOG_SPAN_CAPACITY + 1) * 8
const operationCodes = new Map<string, number>(
  OPERATION_NAMES.map((name, index) => [name, index + 1])
)

export type HangWatchdogSpanSnapshot = {
  inFlightSpans: { name: string; elapsedMs: number }[]
  droppedSpanCount: number
}

export function createHangWatchdogSpanTracker(): {
  buffer: SharedArrayBuffer
  observer: SpanLifecycleObserver
  clear: () => void
} {
  const buffer = new SharedArrayBuffer(HANG_WATCHDOG_SPAN_BUFFER_BYTES)
  const slots = new BigInt64Array(buffer)
  const freeSlots = Array.from({ length: HANG_WATCHDOG_SPAN_CAPACITY }, (_, index) => index + 1)
  const spanSlots = new Map<string, number>()
  return {
    buffer,
    observer: {
      started(spanId, name, startedAt) {
        const code = operationCodes.get(name)
        if (!code || spanSlots.has(spanId)) {
          return
        }
        if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt >= 2 ** 47) {
          return
        }
        const slot = freeSlots.pop()
        if (slot === undefined) {
          const dropped = Atomics.load(slots, 0)
          Atomics.store(
            slots,
            0,
            dropped < BigInt(Number.MAX_SAFE_INTEGER) ? dropped + 1n : dropped
          )
          return
        }
        spanSlots.set(spanId, slot)
        // One atomic word keeps the operation and its timestamp consistent during slot reuse.
        Atomics.store(slots, slot, BigInt(startedAt) * 256n + BigInt(code))
      },
      ended(spanId) {
        const slot = spanSlots.get(spanId)
        if (slot === undefined) {
          return
        }
        Atomics.store(slots, slot, 0n)
        spanSlots.delete(spanId)
        freeSlots.push(slot)
      }
    },
    clear() {
      for (const slot of spanSlots.values()) {
        Atomics.store(slots, slot, 0n)
      }
      spanSlots.clear()
      freeSlots.length = 0
    }
  }
}

export function readHangWatchdogSpanSnapshot(
  buffer: SharedArrayBuffer,
  now: number
): HangWatchdogSpanSnapshot {
  const slots = new BigInt64Array(buffer)
  const inFlightSpans: HangWatchdogSpanSnapshot['inFlightSpans'] = []
  for (let slot = 1; slot <= HANG_WATCHDOG_SPAN_CAPACITY; slot++) {
    const value = Atomics.load(slots, slot)
    if (value <= 0n) {
      continue
    }
    const name = OPERATION_NAMES[Number(value % 256n) - 1]
    if (!name) {
      continue
    }
    inFlightSpans.push({ name, elapsedMs: Math.max(0, now - Number(value / 256n)) })
  }
  return { inFlightSpans, droppedSpanCount: Number(Atomics.load(slots, 0)) }
}

export function parseHangWatchdogSpanSnapshot(value: unknown): HangWatchdogSpanSnapshot | null {
  if (typeof value !== 'object' || !value || !('inFlightSpans' in value)) {
    return null
  }
  if (!Array.isArray(value.inFlightSpans)) {
    return null
  }
  const inFlightSpans: HangWatchdogSpanSnapshot['inFlightSpans'] = []
  for (const span of value.inFlightSpans.slice(0, HANG_WATCHDOG_SPAN_CAPACITY)) {
    if (typeof span !== 'object' || !span || !('name' in span) || !('elapsedMs' in span)) {
      continue
    }
    if (typeof span.name !== 'string' || !operationCodes.has(span.name)) {
      continue
    }
    if (
      typeof span.elapsedMs !== 'number' ||
      !Number.isFinite(span.elapsedMs) ||
      span.elapsedMs < 0
    ) {
      continue
    }
    inFlightSpans.push({ name: span.name, elapsedMs: span.elapsedMs })
  }
  const dropped = 'droppedSpanCount' in value ? value.droppedSpanCount : 0
  return {
    inFlightSpans,
    droppedSpanCount:
      typeof dropped === 'number' && Number.isSafeInteger(dropped) && dropped >= 0 ? dropped : 0
  }
}
