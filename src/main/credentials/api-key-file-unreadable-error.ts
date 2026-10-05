/** A transient read failure; the saved key may be fine, so callers must not ask to re-enter it. */
export class ApiKeyFileUnreadableError extends Error {}
