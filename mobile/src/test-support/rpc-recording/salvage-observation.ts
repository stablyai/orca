/** The mounted module whose reply classification carries the salvage report. */
const SALVAGE_REPORTING_MODULE = 'mobile/src/transport/rpc-operation-reply.ts'
const CLASSIFY = 'classifyRpcReply'

/** What one checked read dropped to stay compatible. */
type SalvageReport = { droppedPaths: readonly string[]; droppedCount: number }
type ClassifiedReply = { variant?: string; salvage?: SalvageReport }
type Classify = (
  operation: { name?: string; method?: string },
  response: unknown
) => ClassifiedReply

let sink: ((name: string, value: unknown) => void) | null = null

/**
 * Routes salvaged reads to the recording being driven. Module-level for the same reason the
 * declared device's sink is: the product module is loaded once per adapter module and the mount
 * that drives it is what knows where its observations go.
 */
export function bindSalvageObserver(effect: (name: string, value: unknown) => void): void {
  sink = effect
}

/**
 * Records what a checked read threw away. `collectSalvageDrops` already builds the report on every
 * decoded reply — a salvaged array drops the elements that do not parse, a salvaged optional drops
 * a member that is present but malformed — and no product code reads it, so which rows a reply lost
 * was invisible to every projection downstream of it. Wrapping the classifier rather than a reader
 * is what makes it every checked read: one seam, carrying the operation the drop happened under.
 *
 * Only a non-empty report is recorded. `droppedCount: 0` on every decoded reply in the corpus is
 * bytes with no observation in them, and an empty report arriving where one used to be non-empty
 * still moves the golden by leaving.
 */
export function observeSalvagedReads(file: string, module: Record<string, unknown>): void {
  if (!file.endsWith(SALVAGE_REPORTING_MODULE)) {
    return
  }
  const classify = module[CLASSIFY]
  if (typeof classify !== 'function') {
    throw new Error(`${SALVAGE_REPORTING_MODULE} no longer exports ${CLASSIFY}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the export was just checked to be callable, and the wrapper passes its arguments through untouched.
  const classified = classify as Classify
  module[CLASSIFY] = (operation: { name?: string; method?: string }, response: unknown) => {
    const outcome = classified(operation, response)
    const salvage = outcome.salvage
    if (sink && salvage && salvage.droppedCount > 0) {
      sink('reply-salvage', {
        operation: operation.name,
        method: operation.method,
        variant: outcome.variant,
        droppedPaths: salvage.droppedPaths,
        droppedCount: salvage.droppedCount
      })
    }
    return outcome
  }
}
