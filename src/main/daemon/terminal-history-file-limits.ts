export const TERMINAL_HISTORY_META_MAX_BYTES = 64 * 1024
export const TERMINAL_HISTORY_LOG_MAX_BYTES = 5 * 1024 * 1024
// Shared reader/writer contract: oversized snapshots trim their oldest rows before commit.
export const TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES = 200_000_000
export const TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES = 16 * 1024 * 1024
