// Why: shared so every dispatch failure path breaks the circuit at the same accumulated failure_count.
export const DISPATCH_CIRCUIT_BREAK_FAILURES = 3
