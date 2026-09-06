/** Bounds applied to untrusted host session-snapshot values before they are projected onto the
 *  page wire. A value outside its contract bound is refused here rather than at the schema, so one
 *  oversized field cannot fail the snapshot the page needs. */
export function boundedText(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : fallback
}

export function boundedNullableText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

export function boundedOptionalText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined
}

export function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined
}
