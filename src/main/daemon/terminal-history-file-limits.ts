export const TERMINAL_HISTORY_META_MAX_BYTES = 64 * 1024
export const TERMINAL_HISTORY_LOG_MAX_BYTES = 5 * 1024 * 1024
// Why deliberately generous: the checkpoint writer is unbounded, and a read cap under what it
// can emit silently drops ALL scrollback on cold restore. This guards a corrupt/runaway file,
// not retention — a 50k-row max preset of ordinary text serializes to ~14MB, ~15x under. Output
// colored per cell can still exceed this; trimming the snapshot writer-side is the real fix.
export const TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES = 200_000_000
export const TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES = 16 * 1024 * 1024
