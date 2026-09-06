/**
 * The rule every provider that reads a usage reply off the wire has to express.
 *
 * 1. Prove the body is a readable object before reading a field off it. A throw from field
 *    access is not a classification — it escapes as an internal `TypeError`, lands in whatever
 *    catch-all the caller has, and puts the engine's own words in the user's tooltip.
 * 2. A recognised field carrying the wrong type is a failed read, not an absent one. Absence can
 *    mean the account genuinely has nothing to report; a present-but-unusable value never can.
 * 3. A failed read settles `error`. It is the only non-destructive verdict: `ok` overwrites the
 *    last good snapshot (`applyStalePolicy` returns fresh verbatim) and `unavailable` discards it
 *    *and* hides the chip (`isProviderConfigured`), which is the surface that would have shown
 *    the user something was wrong.
 * 4. A body naming none of the fields the reading is made of is a failed read, not an empty one.
 *    An HTTP-200 error envelope and a renamed schema both parse; neither is evidence that the
 *    account has nothing to report, and clause 3 says the verdict Orca cannot support is the
 *    destructive one. Clauses 1-3 were prose every provider re-expressed by hand, and this is the
 *    clause that got dropped each time — so it ships as the check itself.
 */
export function isReadableUsageBody(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

export function namesReadableUsageField(body: object, fields: readonly string[]): boolean {
  return fields.some((field) => field in body)
}
