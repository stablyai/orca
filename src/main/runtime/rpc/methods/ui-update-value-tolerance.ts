import type { z } from 'zod'

/**
 * `UiUpdate` rides App.tsx's debounced writer, so one drifted enum member used
 * to fail the WHOLE batch and silently drop sidebar widths, filters and agent
 * acks alongside it. Degrade instead: a value the schema cannot express is
 * dropped from the payload and the rest of the batch still lands. Unknown KEYS
 * stay a hard rejection — the parity assertions exist to catch those.
 */
export function tolerateUnknownValues<TShape extends z.ZodRawShape>(shape: TShape): TShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).catch(() => undefined)
    ])
  ) as unknown as TShape
}

/** Drops the `undefined` entries `tolerateUnknownValues` leaves behind, so a
 *  rejected value reads as absent rather than as an explicit clear. */
export function omitUndefinedValues<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as TValue
}
