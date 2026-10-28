const SALVAGE_REPORTING_MODULE = 'mobile/src/transport/rpc-operation-reply.ts'
const CLASSIFY = 'classifyRpcReply'

type SalvageReport = { droppedPaths: readonly string[]; droppedCount: number }
type ClassifiedReply = { variant?: string; salvage?: SalvageReport }
type Classify = (
  operation: { name?: string; method?: string },
  response: unknown
) => ClassifiedReply

let sink: ((name: string, value: unknown) => void) | null = null

// Bind at mount because classifiers load per adapter module while the run owns the effect recorder.
export function bindSalvageObserver(effect: (name: string, value: unknown) => void): void {
  sink = effect
}

// Wrap the classifier to observe every checked read’s discarded rows/members; downstream projections cannot see them.
// Record only nonempty reports so unchanged decoded replies add no noise.
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
