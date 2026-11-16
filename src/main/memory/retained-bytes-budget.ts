/**
 * Bytes main holds between a producer and a consumer that has not taken them yet. Each holder
 * claims before it holds and releases when its consumer acknowledges; a refused claim is the
 * holder's cue to coalesce or end its stream so the consumer resumes from durable state.
 */
export type RetainedBytesReading = { bytes: number; items: number }

export type RetainedBytesBudget = {
  /** Null when this budget or its parent is full; the release is idempotent. */
  claim: (bytes: number) => (() => void) | null
  reading: () => RetainedBytesReading
}

export function createRetainedBytesBudget(options: {
  maxBytes: number
  maxItems?: number
  /** Bounds this holder together with its siblings, such as every chat-path holder. */
  parent?: RetainedBytesBudget
}): RetainedBytesBudget {
  const { maxBytes, maxItems = Infinity, parent } = options
  let bytes = 0
  let items = 0
  return {
    claim(claimed) {
      if (
        !Number.isFinite(claimed) ||
        claimed < 0 ||
        items >= maxItems ||
        bytes + claimed > maxBytes
      ) {
        return null
      }
      const releaseParent = parent ? parent.claim(claimed) : () => {}
      if (!releaseParent) {
        return null
      }
      bytes += claimed
      items += 1
      return once(() => {
        bytes -= claimed
        items -= 1
        releaseParent()
      })
    },
    reading: () => ({ bytes, items })
  }
}

function once(release: () => void): () => void {
  let released = false
  return () => {
    if (!released) {
      released = true
      release()
    }
  }
}

const observed = new Map<string, Set<() => RetainedBytesReading>>()

/** Every holder, budgeted or only counted, reports here for crash annotations and breadcrumbs. */
export function observeRetainedBytes(source: string, read: () => RetainedBytesReading): () => void {
  const readers = observed.get(source) ?? new Set()
  readers.add(read)
  observed.set(source, readers)
  return once(() => {
    readers.delete(read)
    if (readers.size === 0) {
      observed.delete(source)
    }
  })
}

export function readRetainedBytes(): Record<string, RetainedBytesReading> {
  const readings: Record<string, RetainedBytesReading> = {}
  for (const [source, readers] of observed) {
    const total = { bytes: 0, items: 0 }
    for (const read of readers) {
      try {
        const reading = read()
        total.bytes += reading.bytes
        total.items += reading.items
      } catch {
        // A closing holder may reject a late read; diagnostics only.
      }
    }
    readings[source] = total
  }
  return readings
}
