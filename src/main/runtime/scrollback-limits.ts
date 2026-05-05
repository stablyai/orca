// Why: mobile subscribers hydrate the runtime headless emulator from the
// desktop renderer's xterm buffer. The renderer holds a 50k-row scrollback;
// shipping all of it across IPC + replaying through HeadlessEmulator is
// expensive and unnecessary for a phone screen. Cap at 1000 rows so the seed
// covers a meaningful amount of agent context while keeping the round-trip
// bounded. See docs/mobile-prefer-renderer-scrollback.md.
export const MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000
