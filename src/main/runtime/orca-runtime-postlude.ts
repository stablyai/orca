import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'
import { REPO_SEARCH_REFS_DEFAULT_LIMIT } from '../../shared/repo-search-limits'

export const WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS = 50

// New-chunk/short-carry prompt matches bypass throttling so blocked status publishes immediately.
export const WAIT_BLOCKED_KEYWORD_PATTERN =
  /press enter|press t to trust|do you trust|trust this|trusted workspace|permission required|requires permission|allow once|allow always|update available|choose working directory|codex just got an upgrade|hooks need review/

export const WAIT_BLOCKED_KEYWORD_CARRY_CHARS = 31

export const AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 8_000

export const VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 750

export const VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS = 1_000

export const TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS = 10

export const DEFAULT_REPO_SEARCH_REFS_LIMIT = REPO_SEARCH_REFS_DEFAULT_LIMIT

export const DEFAULT_TERMINAL_LIST_LIMIT = 200

export const DEFAULT_WORKTREE_LIST_LIMIT = 200

export const DEFAULT_WORKTREE_PS_LIMIT = 200

export const DISCONNECTED_PTY_RECORD_MAX = 128

export const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000

// Sparse patterns and packed-ref/reftable tip edits can evade admin stamps; periodically force a real scan.
export const WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS = 5 * 60_000

// Reserve fallback git worktree list time inside the caller's budget, even after probe timeout.
export const WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS = 1500

// Bound probes inside repo timeout minus fallback allowance; expired probes return null and force a real scan.
// Smaller probe budgets would discard usable results: fallback reads a superset of the same files.
export const WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS =
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS - WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS

export const PTY_CONTROLLER_LIST_TIMEOUT_MS = 3000

export const PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS = 500

// Renderer waits 15s; release the spawn fence and return verified failure before its deadline.
export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS = 12_000

// Unsupported CLIs/plain shells lack title transitions; cap tui-idle instead of waiting indefinitely.
export const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export const TUI_IDLE_POLL_INTERVAL_MS = 2000

export const TUI_IDLE_QUIESCENCE_MS = 3000

// Finite holds must exceed legacy 300ms debounce and cannot exceed one hour.
export const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000

export const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1000
