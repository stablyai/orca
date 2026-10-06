// Why: v5 widens Claude ownership keys (message-id / uuid fallbacks). Older
// caches either lack ownership or used narrower keys and can under/over-count
// after fork reclaim (#8006). v6 adds the 1-hour cache-write split, which older
// caches never recorded, so their cost estimates stay stuck at the 5m rate (#15993).
// Electron-free so the relay's per-file cache is invalidated by the same bump.
export const CLAUDE_USAGE_SCHEMA_VERSION = 6
