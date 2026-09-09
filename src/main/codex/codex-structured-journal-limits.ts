export const MAX_CODEX_GENERIC_ROWS_PER_TURN = 8
export const MAX_CODEX_GENERIC_TURN_BUCKETS = 64
export const MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES = 128
export const MAX_CODEX_GENERIC_BOOKKEEPING_BYTES = 32 * 1024
export const MAX_CODEX_ACTIVE_ITEMS = 256
export const MAX_CODEX_PENDING_PROMPTS = 128
export const MAX_CODEX_IDENTITY_ENTRIES = 512
export const MAX_CODEX_DETAIL_ENTRIES = 512
export const MAX_CODEX_DETAIL_BYTES = 64 * 1024
/** Spawn-group rows kept live per session, and children per row. Both bound an
 *  event-accumulated map that no provider snapshot ever prunes. */
export const MAX_CODEX_SUBAGENT_GROUPS = 32
export const MAX_CODEX_SUBAGENTS_PER_GROUP = 64
/** Threads whose latest token total is retained. Usage frames arrive for
 *  threads that are not yet (or never become) roster children. */
export const MAX_CODEX_TOKEN_USAGE_THREADS = 256
