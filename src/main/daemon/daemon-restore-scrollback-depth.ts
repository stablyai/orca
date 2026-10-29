import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal-scrollback-policy'

// Durable recovery retains full desktop depth while the live daemon window stays smaller.
export const DAEMON_RESTORE_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
