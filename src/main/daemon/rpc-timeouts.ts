// Why these live apart from the client: the renderer's spawn-settlement watchdog must
// outlast them, and its budget test imports them from here to prove it still does. That
// test typechecks under the web config, so this file must stay import-free.
export const CONNECT_TIMEOUT_MS = 5000
export const CONNECTION_ATTEMPT_WAIT_MS = CONNECT_TIMEOUT_MS * 4
export const REQUEST_TIMEOUT_MS = 30000
