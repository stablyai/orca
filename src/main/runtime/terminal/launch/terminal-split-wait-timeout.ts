/** waitForLeafInTab's timeout; the pending-split error keeps it as its prefix for existing callers. */
export const SPLIT_PANE_WAIT_TIMEOUT_MESSAGE = 'Timed out waiting for split pane handle'
/** How long a window has to list the new pane. */
export const SPLIT_PANE_APPEAR_TIMEOUT_MS = 10_000
/** A listed pane is starting its terminal; stays under the CLI's 60 s request timeout. */
export const SPLIT_PANE_START_TIMEOUT_MS = 30_000
