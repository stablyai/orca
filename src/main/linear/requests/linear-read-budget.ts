// Uncapped reads stop here and report hasMore before the CLI RPC deadline.
const LINEAR_UNCAPPED_READ_BUDGET_MS = 20_000

export function linearUncappedReadDeadline(): number {
  return Date.now() + LINEAR_UNCAPPED_READ_BUDGET_MS
}
