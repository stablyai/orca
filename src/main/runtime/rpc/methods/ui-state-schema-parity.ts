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
