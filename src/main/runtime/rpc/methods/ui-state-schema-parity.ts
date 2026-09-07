/**
 * The client-facing UI schemas are `.strict()`, so Zod rejects an unlisted key
 * instead of stripping it — the dispatcher then fails the WHOLE `ui.set` payload
 * with `invalid_argument`. A field added to `PersistedUIState`/`TaskResumeState`
 * without a matching schema entry therefore silently breaks every paired
 * web/mobile/relay client while desktop (schema-less `ui:set` IPC) stays green.
 *
 * Assigning `true` to this type turns that runtime drift into a typecheck error
 * that names the missing key.
 */
export type AssertNoMissingKeys<TType, TSchema extends Record<string, unknown>> =
  Exclude<keyof TType, keyof TSchema> extends never
    ? true
    : { missingFromSchema: Exclude<keyof TType, keyof TSchema> }

/**
 * Key parity alone is blind to VALUE drift: a schema can list `rightSidebarTab`
 * yet omit half its union members, which the strict schema then rejects. This
 * asserts the schema's accepted value domain still covers the shared type for
 * EVERY shared key, so a field nobody thought to name is covered too.
 *
 * `TSchema` must be the schema's INPUT type: what a client is allowed to send,
 * before any `.transform()` narrows it.
 */
export type AssertNoMissingValues<TType, TSchema> =
  MissingValueKeys<TType, TSchema> extends never
    ? true
    : { valueDomainTooNarrowFor: MissingValueKeys<TType, TSchema> }

// Only `undefined` is stripped: optionality is the key guard's job, and a schema
// field is always `| undefined` once `.optional()` is applied. `null` must stay —
// dropping `.nullable()` from a `| null` field is the same batch-rejecting drift.
type MissingValueKeys<TType, TSchema> = {
  [K in Extract<keyof TType, keyof TSchema>]: Exclude<TType[K], undefined> extends Exclude<
    TSchema[K],
    undefined
  >
    ? never
    : K
}[Extract<keyof TType, keyof TSchema>]
