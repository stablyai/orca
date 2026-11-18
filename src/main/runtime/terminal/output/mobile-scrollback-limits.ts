// Bound phone snapshots: replaying the full 50k-row buffer across IPC/headless emulation is expensive (docs/mobile-prefer-renderer-scrollback.md).
export const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
export const MOBILE_SNAPSHOT_BYTE_BUDGET = 512 * 1024
// Why more for a WSL-moved pane: its first subscriber is the only one to see the history the host
// replayed from the move, and the 1000-row cut would drop the rest for good. Same byte budget.
export const MOVED_PANE_SUBSCRIBE_SCROLLBACK_ROWS = 5000
