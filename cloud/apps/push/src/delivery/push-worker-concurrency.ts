// Twelve concurrent deliveries exceed the ~30/s limit of four ~120ms drains; database concurrency is bounded separately.
export const WORKER_DRAINS = 12
