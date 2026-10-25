// Bound phone snapshots: replaying the full 50k-row buffer across IPC/headless emulation is expensive (docs/mobile-prefer-renderer-scrollback.md).
export const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
export const MOBILE_SNAPSHOT_BYTE_BUDGET = 512 * 1024
