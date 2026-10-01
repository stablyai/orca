// Twelve drains lift the ~30/s ceiling four drains hit at ~120 ms per item; each drain holds one
// delivery in flight, so this is the worker's concurrency, not its database draw.
export const WORKER_DRAINS = 12
