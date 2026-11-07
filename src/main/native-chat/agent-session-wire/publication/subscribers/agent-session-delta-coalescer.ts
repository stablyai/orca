import { AgentSessionDeltaDigest } from './agent-session-delta-digest'
import {
  type AgentSessionDeltaSnapshot,
  type AgentSessionDeltaStream,
  snapshotOf
} from './agent-session-delta-snapshot'
import { appendWithinUtf8ByteLimit } from './agent-session-delta-prefix'
import type { StructuredAgentSessionSinkAdmission } from '../../journal-ingress/structured-agent-session-event-sink'

// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60
export const AGENT_SESSION_TEXT_CHECKPOINT_MS = 400

/** Milliseconds until text last saved at `acceptedAt` may save again; never-saved text is due now. */
export function agentSessionTextCheckpointDueIn(acceptedAt: number | undefined): number {
  return acceptedAt === undefined
    ? 0
    : acceptedAt + AGENT_SESSION_TEXT_CHECKPOINT_MS - performance.now()
}

/** Bound accumulated legal deltas independently of input record admission. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export { AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER } from './agent-session-delta-prefix'
export type { AgentSessionDeltaSnapshot } from './agent-session-delta-snapshot'
export const AGENT_SESSION_MAX_STREAMS = 256

export type AgentSessionDeltaCoalescerDeps = {
  /** Emit the complete snapshot, not the increment. */
  emit: (key: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  /** Keep a running digest so bounded() previews of this stream never join its whole text. */
  digests?: (key: string) => boolean
  /** False skips this delivery attempt and marks it clean; emit reports sink refusal. */
  shouldEmit?: (key: string, textLength: number) => boolean
  /** Milliseconds until a timer flush may emit this stream; the timer re-arms for it. Barriers ignore it. */
  dueIn?: (key: string) => number
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  maxStreams?: number
  /** Caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  schedule?: (run: () => void, ms: number) => () => void
  isCurrent?: () => boolean
  onScheduledFailure?: (
    admission: StructuredAgentSessionSinkAdmission & { accepted: false }
  ) => void
}

export type AgentSessionDeltaCoalescer = {
  /** Refusal leaves the incoming delta unconsumed. */
  append: (key: string, delta: string) => StructuredAgentSessionSinkAdmission
  /** Return the buffer the next nonempty append would evict, without changing it. */
  evictionFor: (key: string) => string | undefined
  flush: (key: string) => StructuredAgentSessionSinkAdmission
  /** Lifecycle barriers flush every stream first; `only` limits forcing, others keep dueIn. */
  flushAll: (only?: (key: string) => boolean) => StructuredAgentSessionSinkAdmission
  /** Authoritative bodies supersede buffered text; drop it without emission. */
  forget: (key: string) => void
  dispose: () => void
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  dirty: (
    select?: (key: string) => boolean
  ) => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** External writes satisfy the current snapshot until more text arrives. */
  markFlushed: (key: string) => void
}

export function scheduleAgentSessionDeltaFlush(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? scheduleAgentSessionDeltaFlush
  const maxRetainedBytes = deps.maxRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
  const maxTotalRetainedBytes =
    deps.maxTotalRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
  const maxStreams = Math.max(1, deps.maxStreams ?? AGENT_SESSION_MAX_STREAMS)
  const streams = new Map<string, AgentSessionDeltaStream>()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  let armedAt = Infinity
  const evictable = new Set<string>()

  const flushKey = (key: string): StructuredAgentSessionSinkAdmission => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return { accepted: true }
    }
    if (deps.shouldEmit?.(key, stream.textLength) === false) {
      stream.dirty = false
      return { accepted: true }
    }
    const emitted = normalizeAdmission(deps.emit(key, snapshotOf(stream)))
    if (!emitted.accepted) {
      return emitted
    }
    stream.dirty = false
    return emitted
  }

  const cancelArmed = (): void => {
    cancelTimer?.()
    cancelTimer = null
    armedAt = Infinity
  }

  // A stream saves one window after its oldest unsaved delta, and no sooner than dueIn allows.
  const waitFor = (key: string, stream: AgentSessionDeltaStream): number =>
    Math.max(stream.dirtyAt + windowMs - performance.now(), deps.dueIn?.(key) ?? 0)

  // One shared timer keeps the earliest deadline.
  const arm = (delayMs: number): void => {
    const at = performance.now() + Math.max(0, delayMs)
    if (streams.size === 0 || armedAt <= at) {
      return
    }
    cancelArmed()
    armedAt = at
    cancelTimer = schedule(
      () => {
        cancelTimer = null
        armedAt = Infinity
        if (deps.isCurrent?.() === false) {
          return
        }
        const admission = flushAll(at)
        if (!admission.accepted && admission.reason !== 'backpressure') {
          deps.onScheduledFailure?.(admission)
        }
      },
      // Timers truncate fractional delays; round up so a wake is never early.
      Math.max(0, Math.ceil(at - performance.now()))
    )
  }

  /** `wakeAt` is the deadline a timer flush was armed for; barriers pass undefined. */
  const flushAll = (
    wakeAt: number | undefined,
    only?: (key: string) => boolean
  ): StructuredAgentSessionSinkAdmission => {
    cancelArmed()
    let emitted: StructuredAgentSessionSinkAdmission = { accepted: true }
    let deferredMs = Infinity
    for (const [key, stream] of streams) {
      const forced = wakeAt === undefined && (only?.(key) ?? true)
      // A wake saves only streams whose own window has closed by its deadline; barriers ignore windows.
      const deferred =
        !forced &&
        stream.dirty &&
        ((deps.dueIn?.(key) ?? 0) > 0 ||
          (wakeAt !== undefined && stream.dirtyAt + windowMs > wakeAt))
      if (deferred) {
        deferredMs = Math.min(deferredMs, waitFor(key, stream))
        continue
      }
      const admission = flushKey(key)
      if (!admission.accepted) {
        emitted = admission
        if (admission.reason !== 'backpressure') {
          return emitted
        }
      }
    }
    if (!emitted.accepted) {
      arm(windowMs)
    }
    if (deferredMs !== Infinity) {
      arm(deferredMs)
    }
    return emitted
  }

  return {
    append: (key, delta) => {
      if (delta.length === 0) {
        return { accepted: true }
      }
      let stream = streams.get(key)
      if (!stream) {
        // Flush before eviction so a new untrusted ID cannot erase observed output.
        while (!deps.isProtected?.(key) && evictable.size >= maxStreams) {
          const oldest = evictable.values().next().value
          if (oldest) {
            if (deps.isProtected?.(oldest)) {
              evictable.delete(oldest)
              continue
            }
            // Backpressure must retain observed text for retry.
            const admission = flushKey(oldest)
            if (!admission.accepted) {
              return admission
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.retainedBytes
            }
            streams.delete(oldest)
            evictable.delete(oldest)
          }
          break
        }
        stream = {
          chunks: [],
          retainedBytes: 0,
          textLength: 0,
          observedBytes: 0,
          truncated: false,
          dirty: false,
          dirtyAt: 0,
          digest: deps.digests?.(key) ? new AgentSessionDeltaDigest() : null
        }
        if (!deps.isProtected?.(key)) {
          evictable.add(key)
        }
      } else if (deps.isProtected?.(key)) {
        evictable.delete(key)
      }
      const deltaBytes = Buffer.byteLength(delta, 'utf8')
      stream.observedBytes += deltaBytes
      if (!stream.truncated) {
        const availableTotal = Math.max(0, maxTotalRetainedBytes - totalRetainedBytes)
        const streamLimit = Math.min(maxRetainedBytes, stream.retainedBytes + availableTotal)
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          deltaBytes,
          streamLimit
        )
        totalRetainedBytes += next.retainedBytes - stream.retainedBytes
        if (next.truncated) {
          stream.digest?.reset(next.chunks)
        } else {
          stream.digest?.append(delta)
        }
        stream.textLength = next.truncated
          ? (next.chunks[0]?.length ?? 0)
          : stream.textLength + delta.length
        stream.chunks = next.chunks
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        if (!stream.dirty) {
          stream.dirtyAt = performance.now()
          stream.dirty = true
        }
      }
      streams.set(key, stream)
      if (stream.dirty) {
        // Never sooner than a window: a refused retry keeps its delay.
        arm(Math.max(windowMs, waitFor(key, stream)))
      }
      return { accepted: true }
    },
    evictionFor: (key) => {
      if (streams.has(key) || deps.isProtected?.(key) || evictable.size < maxStreams) {
        return undefined
      }
      let remaining = evictable.size
      for (const oldest of evictable) {
        if (remaining < maxStreams) {
          return undefined
        }
        if (!deps.isProtected?.(oldest)) {
          return oldest || undefined
        }
        remaining -= 1
      }
      return undefined
    },
    flush: flushKey,
    flushAll: (only) => flushAll(undefined, only),
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelArmed()
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream ? snapshotOf(stream) : null
    },
    dirty: (select) =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty && (select?.(key) ?? true) ? [{ key, snapshot: snapshotOf(stream) }] : []
      ),
    markFlushed: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.dirty = false
      }
    }
  }
}

function isAdmission(value: unknown): value is StructuredAgentSessionSinkAdmission {
  if (typeof value === 'object' && value !== null && 'accepted' in value) {
    if (value.accepted === true) {
      return true
    }
    if (
      value.accepted === false &&
      'reason' in value &&
      (value.reason === 'backpressure' || value.reason === 'failed' || value.reason === 'closed')
    ) {
      return true
    }
  }
  return false
}

function normalizeAdmission(value: unknown): StructuredAgentSessionSinkAdmission {
  return isAdmission(value)
    ? value
    : value === false
      ? { accepted: false, reason: 'backpressure' }
      : { accepted: true }
}
