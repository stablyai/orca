export const MAX_CODEX_GENERIC_ROWS_PER_TURN = 8
/** Stored-only rows (no client draws them) per turn; past it they are dropped without a summary. */
export const MAX_CODEX_WORDLESS_ROWS_PER_TURN = 8
export const MAX_CODEX_GENERIC_TURN_BUCKETS = 64
export const MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES = 128
export const MAX_CODEX_GENERIC_BOOKKEEPING_BYTES = 32 * 1024
/** Goal duplicate-suppression state is LRU-bounded per live translator. */
export const MAX_CODEX_GOAL_THREADS = 64
export const MAX_CODEX_ACTIVE_ITEMS = 256
export const MAX_CODEX_PENDING_PROMPTS = 128
export const MAX_CODEX_IDENTITY_ENTRIES = 512
export const MAX_CODEX_DETAIL_ENTRIES = 512
export const MAX_CODEX_DETAIL_BYTES = 64 * 1024
/** Settled spawn-group history budget; live groups remain until their final write succeeds. */
export const MAX_CODEX_SUBAGENT_GROUPS = 32
/** Children admitted per spawn-group row. */
export const MAX_CODEX_SUBAGENTS_PER_GROUP = 64
/** Threads whose latest token total is retained. Usage frames arrive for
 *  threads that are not yet (or never become) roster children. */
export const MAX_CODEX_TOKEN_USAGE_THREADS = 256
