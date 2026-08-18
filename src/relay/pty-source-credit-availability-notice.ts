/**
 * Guarded fan-out of "this delivery released credit" to the publication layer.
 */
export function notifyPtySourceCreditAvailable(
  notify: ((id: string) => void) | undefined,
  id: string
): void {
  try {
    notify?.(id)
  } catch (err) {
    // Why: this fires from request handlers, detach paths, and a bare grace setTimeout; a
    // downstream throw in the timer would reach uncaughtException and kill the daemon.
    process.stderr.write(
      `[pty-source-credit] credit-available notification failed for ${id}: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }\n`
    )
  }
}
