import type {
  AgentSessionDeltaStream,
  AgentSessionDeltaWindow,
  AgentSessionDeltaCoalescerDeps,
  AgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer-contracts'
export type {
  AgentSessionDeltaSnapshot,
  AgentSessionDeltaSource,
  AgentSessionDeltaWindow,
  AgentSessionDeltaCoalescerDeps,
  AgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer-contracts'
import {
  appendAgentSessionTextCut,
  agentSessionTextPairBoundary
} from './agent-session-text-encoding'
import { appendWithinUtf8ByteLimit } from './agent-session-streamed-text-bounds'
// Server-side coalescing for streamed assistant text.
//
// Providers emit one notification per token. Journaling each one would write a
// row and wake every subscriber per token, so a single long answer costs
// thousands of appends and thousands of stream frames on a phone. Deltas are
// therefore accumulated and flushed on a short window. The host saves suffixes;
// subscriber frames still carry the committed whole value.
//
// The window applies to text only. Lifecycle — an item completing, a turn
// ending, an approval arriving — bypasses it by flushing first, so nothing can
// be journaled ahead of the text that preceded it.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60

/** Bound accumulated legal deltas independently of input record admission. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export { AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER } from './agent-session-streamed-text-bounds'
export const AGENT_SESSION_MAX_STREAMS = 256

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  const unrefable: unknown = timer
  if (
    typeof unrefable === 'object' &&
    unrefable !== null &&
    'unref' in unrefable &&
    typeof unrefable.unref === 'function'
  ) {
    unrefable.unref()
  }
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? defaultSchedule
  const maxRetainedBytes = deps.maxRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
  const maxTotalRetainedBytes =
    deps.maxTotalRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
  const maxStreams = Math.max(1, deps.maxStreams ?? AGENT_SESSION_MAX_STREAMS)
  const streams = new Map<string, AgentSessionDeltaStream>()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  const evictable = new Set<string>()

  const windowFor = (key: string): AgentSessionDeltaWindow | null => {
    const stream = streams.get(key)
    if (!stream) {
      return null
    }
    const chunks = stream.chunks
    const length = stream.textLength
    const retained = stream.retainedBytes
    const beforeHandover = stream.source
    let whole: string | undefined
    return {
      applied: (source) => {
        if (streams.get(key) === stream) {
          const current = deps.source?.(key) ?? source
          const credited = Math.max(
            0,
            current.bytes +
              stream.retainedBytes -
              (stream.source === beforeHandover ? retained : 0) -
              stream.uncreditedBytes
          )
          totalRetainedBytes += credited - stream.residentBytes
          stream.residentBytes = credited
          stream.source = current
        }
      },
      source: stream.source,
      cuts: { blocks: stream.cuts.blocks, count: stream.cuts.count },
      limit: stream.limit,
      length: (stream.source?.length ?? 0) + stream.textLength,
      bytes: (stream.source?.bytes ?? 0) + stream.retainedBytes,
      encodedBytes: (stream.source?.encodedBytes ?? 0) + stream.encodedBytes,
      hasText: stream.hasText,
      baseLength: (stream.source?.length ?? 0) + stream.admittedLength,
      suffix: stream.truncated ? '' : stream.pending.join(''),
      text: () => (whole ??= chunks.join('').slice(0, length)),
      ...(stream.truncated ? { replace: true as const } : {}),
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    }
  }

  const markFlushed = (key: string): void => {
    const stream = streams.get(key)
    if (stream) {
      stream.dirty = false
      const source = deps.source?.(key)
      if (source) {
        stream.source = source
        stream.pending = []
        stream.chunks = []
        stream.retainedBytes = 0
        stream.textLength = 0
        stream.encodedBytes = 0
        stream.admittedLength = 0
        stream.cuts = { blocks: [], count: 0 }
        stream.lastCodeUnit = Number.NaN
      } else if (!deps.source) {
        stream.admittedLength = stream.textLength
        stream.pending = []
      }
    }
  }

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    const window = windowFor(key)
    if (!window) {
      return true
    }
    const text = deps.emitDelta ? '' : window.text()
    const emitted = deps.emitDelta
      ? deps.emitDelta(key, window)
      : deps.emit(key, text, {
          text,
          observedBytes: stream.observedBytes,
          truncated: stream.truncated
        })
    if (emitted === false) {
      return false
    }
    markFlushed(key)
    return true
  }

  const scheduleFlush = (): void => {
    cancelTimer ??= schedule(() => {
      cancelTimer = null
      flushAll()
    }, windowMs)
  }

  const flushAll = (): boolean => {
    cancelTimer?.()
    cancelTimer = null
    let emitted = true
    for (const key of streams.keys()) {
      emitted = flushKey(key) && emitted
    }
    if (!emitted) {
      scheduleFlush()
    }
    return emitted
  }

  return {
    append: (key, delta) => {
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
            if (!flushKey(oldest)) {
              return false
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.residentBytes
            }
            streams.delete(oldest)
            evictable.delete(oldest)
          }
          break
        }
        stream = {
          source: deps.source?.(key),
          encodedBytes: 0,
          chunks: [],
          retainedBytes: 0,
          residentBytes: 0,
          uncreditedBytes: deps.source?.(key)?.bytes ?? 0,
          cuts: { blocks: [], count: 0 },
          lastCodeUnit: Number.NaN,
          textLength: 0,
          observedBytes: deps.source?.(key)?.observedBytes ?? 0,
          truncated: deps.source?.(key)?.truncated ?? false,
          dirty: false,
          admittedLength: 0,
          pending: [],
          hasText: (deps.source?.(key)?.length ?? 0) > 0
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
        const streamLimit = Math.min(
          maxRetainedBytes,
          (stream.source?.bytes ?? 0) + stream.retainedBytes + availableTotal
        )
        if (agentSessionTextPairBoundary(stream.lastCodeUnit, delta.charCodeAt(0))) {
          appendAgentSessionTextCut(stream.cuts, stream.textLength)
        }
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          deltaBytes,
          stream.source ? Math.max(0, streamLimit - stream.source.bytes) : streamLimit
        )
        if (stream.source && next.truncated) {
          stream.limit = streamLimit
        }
        stream.encodedBytes = next.truncated
          ? Buffer.byteLength(JSON.stringify(next.chunks.join('')), 'utf8') - 2
          : stream.encodedBytes + Buffer.byteLength(JSON.stringify(delta), 'utf8') - 2
        const credited = next.retainedBytes - stream.retainedBytes
        stream.residentBytes += credited
        totalRetainedBytes += credited
        stream.textLength = next.truncated
          ? (next.chunks[0]?.length ?? 0)
          : stream.textLength + delta.length
        stream.chunks = next.chunks
        if (next.truncated) {
          stream.cuts = { blocks: [], count: 0 }
        }
        if (delta.length) {
          stream.lastCodeUnit = next.truncated
            ? (next.chunks[0]?.charCodeAt((next.chunks[0]?.length ?? 0) - 1) ?? Number.NaN)
            : delta.charCodeAt(delta.length - 1)
        }
        stream.hasText ||= next.truncated ? !!next.chunks[0]?.trim() : delta.trim().length > 0
        if (!next.truncated) {
          stream.pending.push(delta)
        }
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        stream.dirty = true
      }
      streams.set(key, stream)
      // Share one timer across streams to bound wakeups per window.
      scheduleFlush()
      return true
    },
    flush: flushKey,
    flushAll,
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.residentBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream
        ? {
            text: stream.chunks.join(''),
            observedBytes: stream.observedBytes,
            truncated: stream.truncated
          }
        : null
    },
    dirty: () =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty
          ? [
              {
                key,
                snapshot: {
                  text: stream.chunks.join(''),
                  observedBytes: stream.observedBytes,
                  truncated: stream.truncated
                }
              }
            ]
          : []
      ),
    markFlushed,
    dirtyWindows: () =>
      [...streams].flatMap(([key, stream]) => {
        const window = stream.dirty ? windowFor(key) : null
        return window ? [{ key, window }] : []
      }),
    window: windowFor
  }
}
