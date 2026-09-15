/**
 * A refused operation's message, or the screen's own copy when the host sent none. Only the
 * refusal catch may call this: a transport rejection's message is surfaced verbatim, empty included.
 */
export function refusedRpcMessageOrFallback(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : '') || fallback
}

/**
 * An error a host reported inside an accepted reply, or the screen's copy when it sent none.
 *
 * The host contract declares `error` as a string, so a non-string is a malformed reply and reads
 * as absent — every consumer is display or prompt text, and main's pass-through made
 * `summarizeCommitFailure` throw on `.slice`.
 */
export function hostReplyErrorTextOrFallback(value: unknown, fallback: string): string {
  return (typeof value === 'string' ? value : '') || fallback
}
