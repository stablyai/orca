/** The one turn every step that changes a moved automation's on/off state takes. */

let exclusive: Promise<unknown> = Promise.resolve()

/**
 * Undo (stop, release), the left-off retry and the rewrite pass's automation steps take turns: a
 * host copy turned on while an undo releases the move would stay on beside the copy here.
 */
export function runWslMoveHostAutomationsExclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = exclusive.then(run, run)
  exclusive = next.catch(() => {})
  return next
}
