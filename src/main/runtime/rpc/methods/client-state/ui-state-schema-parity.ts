/** Strict UI schemas reject whole paired-client payloads on unknown keys; desktop bypasses them, so enforce shared-type parity at typecheck. */
export type AssertNoMissingKeys<TType, TSchema extends Record<string, unknown>> =
  Exclude<keyof TType, keyof TSchema> extends never
    ? true
    : { missingFromSchema: Exclude<keyof TType, keyof TSchema> }

/** Check accepted values for every shared key too; use schema INPUT before transforms to catch missing union members. */
export type AssertNoMissingValues<TType, TSchema> =
  MissingValueKeys<TType, TSchema> extends never
    ? true
    : { valueDomainTooNarrowFor: MissingValueKeys<TType, TSchema> }

// Strip undefined only: optionality has its own guard, while dropping null would hide missing nullable support.
type MissingValueKeys<TType, TSchema> = {
  [K in Extract<keyof TType, keyof TSchema>]: Exclude<TType[K], undefined> extends Exclude<
    TSchema[K],
    undefined
  >
    ? never
    : K
}[Extract<keyof TType, keyof TSchema>]
