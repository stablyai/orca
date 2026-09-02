import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal-scrollback-policy'

// Why this number: it is the desktop default that rebuilds restored before the live
// daemon window was flattened. Durable history keeps this depth; live RAM stays smaller.
export const DAEMON_RESTORE_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
