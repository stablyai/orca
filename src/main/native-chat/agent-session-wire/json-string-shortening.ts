// Fit long strings to one common length; preserve identifiers because readers key and answer by them.
// Mark clipped heads with truncated and other strings with an ellipsis.

import type { AgentJournalBoundedPayload } from '../../../shared/agent-session-journal-types'

const ELLIPSIS = '…'
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8')
// Tiny cuts save little and add visual noise.
const KEEP_AT_LEAST = 64

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function isIdentifierKey(key: string): boolean {
  return key === 'id' || key.endsWith('Id')
}

function isBoundedPayload(value: unknown): value is AgentJournalBoundedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'head' in value &&
    typeof value.head === 'string' &&
    'byteLength' in value &&
    'truncated' in value
  )
}

function headOf(text: string, length: number): string {
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

/** Cut only when savings exceed marker bytes, preserving monotonic size for binary search. */
function cutLongStrings<T>(value: T, length: number): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `cutTo` keeps every key and shape and only shortens strings.
  return cutTo(value, length, '') as T
}

function cutTo(value: unknown, length: number, key: string): unknown {
  if (typeof value === 'string') {
    return value.length > length + ELLIPSIS_BYTES && !isIdentifierKey(key)
      ? `${headOf(value, length)}${ELLIPSIS}`
      : value
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (isBoundedPayload(value)) {
    return value.head.length > length
      ? { ...value, head: headOf(value.head, length), truncated: true }
      : value
  }
  const entries = Object.entries(value)
  const cut = entries.map(([entryKey, entry]) => cutTo(entry, length, entryKey))
  if (cut.every((entry, index) => entry === entries[index]![1])) {
    return value
  }
  return Array.isArray(value)
    ? cut
    : Object.fromEntries(entries.map(([entryKey], index) => [entryKey, cut[index]]))
}

function longestStringLength(value: unknown): number {
  if (typeof value === 'string') {
    return value.length
  }
  if (typeof value !== 'object' || value === null) {
    return 0
  }
  return Object.values(value).reduce<number>(
    (longest, entry) => Math.max(longest, longestStringLength(entry)),
    0
  )
}

/** Return a fitted copy, the original if it fits, or null when minimum-length strings still exceed budget. */
export function shortenJsonStringsToFit<T>(value: T, maxBytes: number): T | null {
  if (jsonBytes(value) <= maxBytes) {
    return value
  }
  const at = (length: number): T => cutLongStrings(value, length)
  if (jsonBytes(at(KEEP_AT_LEAST)) > maxBytes) {
    return null
  }
  // Search the longest common fit; low fits and high does not.
  let low = KEEP_AT_LEAST
  let high = longestStringLength(value)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (jsonBytes(at(middle)) <= maxBytes) {
      low = middle
    } else {
      high = middle
    }
  }
  return at(low)
}
