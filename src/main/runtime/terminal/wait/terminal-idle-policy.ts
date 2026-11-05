// Unsupported CLIs/plain shells lack title transitions; cap tui-idle instead of waiting indefinitely.
export const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export const TUI_IDLE_POLL_INTERVAL_MS = 2000

export const TUI_IDLE_QUIESCENCE_MS = 3000
