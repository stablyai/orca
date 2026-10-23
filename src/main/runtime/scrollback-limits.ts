// Why: mobile subscribers hydrate the runtime headless emulator from the
// desktop renderer's xterm buffer. The renderer holds a 50k-row scrollback;
// shipping all of it across IPC + replaying through HeadlessEmulator is
// expensive and unnecessary for a phone screen. Cap at 1000 rows and 512 KiB so
// the seed covers a meaningful amount of agent context while keeping the
// round-trip bounded. See docs/mobile-prefer-renderer-scrollback.md.
export const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
export const MOBILE_SNAPSHOT_BYTE_BUDGET = 512 * 1024
// Why more for a WSL-moved pane: its first subscriber is the only one to see the history the host
// replayed from the move, and the 1000-row cut would drop the rest for good. Same byte budget.
export const MOVED_PANE_SUBSCRIBE_SCROLLBACK_ROWS = 5000
