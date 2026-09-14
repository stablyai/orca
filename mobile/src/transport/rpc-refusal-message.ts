/**
 * A refused operation's message, or the screen's own copy when the host sent none.
 *
 * Call sites spelled this as `response.error?.message || fallback`. Once the refusal arrives as
 * the acceptance policy's thrown Error, the `||` has to live somewhere — and it must not also
 * cover a transport rejection, whose message main surfaced verbatim, empty string included. So
 * a migrated call site keeps two catches where it had two paths, and only the refusal one calls
 * this.
 */
export function refusedRpcMessageOrFallback(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : '') || fallback
}

/**
 * An error a host reported inside an accepted reply, or the screen's copy when it sent none.
 *
 * Exactly `result?.error || fallback`, including for a truthy non-string: main passed that value
 * through under a `string` annotation, and a downstream `.replace` then threw. Stringifying it
 * here would be an improvement, but an unannounced one inside a migration whose contract is that
 * no behaviour changes — so the pass-through stays and the latent throw is ticketed separately.
 */
export function hostReplyErrorTextOrFallback(value: unknown, fallback: string): string {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reproduces main's own annotation of an unvalidated host field.
  return ((value as string | undefined) || fallback) as string
}
