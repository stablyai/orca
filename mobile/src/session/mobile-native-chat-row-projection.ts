import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

type Fields = Readonly<Record<string, unknown>>
type Row = Fields & { message: NativeChatMessage }

function isProjectionContainer(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return Array.isArray(value) || prototype === Object.prototype || prototype === null
}

// Fetch/recovery freshness keys retain identity even when their previews compare equal.
function isRecoveryFreshnessKey(value: Fields, field?: string): boolean {
  return field === 'raw' || (value.type === 'tool-result' && value.fullOutputItemId !== undefined)
}

// Compare rebuilt projection containers; opaque state and callbacks must retain identity.
function unchanged(previous: unknown, next: unknown, depth: number, field?: string): boolean {
  if (previous === next) {
    return true
  }
  if (depth < 0 || !isProjectionContainer(previous) || !isProjectionContainer(next)) {
    return false
  }
  if (isRecoveryFreshnessKey(previous, field) || isRecoveryFreshnessKey(next, field)) {
    return false
  }
  if (Array.isArray(previous) || Array.isArray(next)) {
    return (
      Array.isArray(previous) &&
      Array.isArray(next) &&
      previous.length === next.length &&
      previous.every((value, index) => unchanged(value, next[index], depth - 1))
    )
  }
  const keys = Object.keys(previous)
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) => Object.hasOwn(next, key) && unchanged(previous[key], next[key], depth - 1, key)
    )
  )
}

export type MobileNativeChatRowProjection<T extends Row> = {
  rows: readonly T[]
  byId: ReadonlyMap<string, T>
}

export function projectMobileNativeChatRows<T extends Row>(
  rows: T[],
  previous?: MobileNativeChatRowProjection<T>
): MobileNativeChatRowProjection<T> {
  const next = rows.map((row) => {
    const prior = previous?.byId.get(row.message.id)
    // Row -> work run -> message -> blocks -> block fields; deeper values retain identity.
    return prior && unchanged(prior, row, 4) ? prior : row
  })
  if (
    previous &&
    next.length === previous.rows.length &&
    next.every((row, at) => row === previous.rows[at])
  ) {
    return previous
  }
  return { rows: next, byId: new Map(next.map((row) => [row.message.id, row])) }
}
