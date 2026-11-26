import type { Row } from './native-chat-4a-report'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {}

export function historyShape(value: unknown, inputCursor: unknown) {
  const result = record(value)
  const page = record(result.page)
  return {
    ok: result.ok ?? null,
    reset: result.reset ?? null,
    items: Array.isArray(page.items) ? page.items.length : null,
    removed: Array.isArray(page.removedItemIds) ? page.removedItemIds.length : null,
    inputCursor: inputCursor ?? null,
    outputCursor: record(page.window).nextCursor ?? null,
    liveCursor: page.liveCursor ?? null,
    epoch: page.epoch ?? record(page.liveCursor).epoch ?? null,
    bytes: Buffer.byteLength(JSON.stringify(value))
  }
}

export function historyComparison(left?: Row, right?: Row): string | null {
  if (!left || !right || left.operation !== 'agentSession.history') {
    return null
  }
  if (left.skipped || right.skipped || !left.samples.length || !right.samples.length) {
    return 'unexercised history shape'
  }
  const signatures = (row: Row) =>
    row.samples
      .map((sample) => {
        const shape = record(sample.evidence?.history)
        if (typeof shape.ok !== 'boolean' || typeof shape.items !== 'number') {
          return 'missing shape'
        }
        // Epoch UUIDs differ after conversion; retain raw cursors, compare their current/stale relation.
        return JSON.stringify(shape, (key, value) =>
          key === 'epoch' && typeof value === 'string'
            ? value === shape.epoch
              ? 'current'
              : 'stale'
            : value
        )
      })
      .sort()
  const a = signatures(left)
  const b = signatures(right)
  return a.includes('missing shape') || JSON.stringify(a) !== JSON.stringify(b)
    ? 'unmatched history/reset count, cursors or payload bytes; delta refused'
    : null
}

export function comparisonInvalid(left?: Row, right?: Row): string | null {
  if (
    !left ||
    !right ||
    left.skipped ||
    right.skipped ||
    !left.samples.length ||
    !right.samples.length
  ) {
    return 'unexercised or incomplete row; delta refused'
  }
  return historyComparison(left, right)
}
