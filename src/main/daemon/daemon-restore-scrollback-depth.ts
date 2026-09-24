import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX } from '../../shared/terminal-scrollback-policy'

// Disk replay must preserve every supported client depth; the live daemon keeps its smaller window.
export const DAEMON_RESTORE_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
