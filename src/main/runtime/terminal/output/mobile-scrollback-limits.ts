import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
// Bound phone snapshots: replaying the full 50k-row buffer across IPC/headless emulation is expensive (docs/mobile-prefer-renderer-scrollback.md).
export const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
export const MOBILE_SNAPSHOT_BYTE_BUDGET = 512 * 1024
// Why more for a WSL-moved pane: its first subscriber is the only one to see the history the host
// replayed from the move, and the 1000-row cut would drop the rest for good. Same byte budget.
export const MOVED_PANE_SUBSCRIBE_SCROLLBACK_ROWS = 5000

// N-02: a desktop subscriber (a cloud pane reattaching after an app restart, a resubscribe) keeps
// the history a local terminal keeps; the 1000-row cut is for phones. Same 2 MB a requested
// desktop snapshot already gets; snapshots go out in chunks, so frame caps don't bound it.
export const DESKTOP_SUBSCRIBE_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
export const DESKTOP_SNAPSHOT_BYTE_BUDGET = 2 * 1024 * 1024
