// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'
import { REPO_SEARCH_REFS_DEFAULT_LIMIT } from '../../shared/repo-search-limits'

export const WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS = 50

// Why: chunks that could complete an actionable prompt bypass the throttle so blocked stamps stay immediate; scanned over the new chunk + short carry, never the whole window.
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

// Why: the Git-admin fingerprint reads HEAD and its ref tip exactly, but sparse-checkout pattern
// edits are invisible to it and a tip living in packed-refs or reftable only gets an mtime + size
// stamp, so a real scan still runs on this interval even while the probe reports "unchanged".
export const WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS = 5 * 60_000

// Why reserved rather than spent on the probe: when the probe expires the caller still has to run
// `git worktree list` and answer inside the same budget, so the fallback needs its own room. Sized
// for a healthy Git on a busy host, well above the tens of milliseconds a warm list costs.
export const WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS = 1500

// Why derived from the caller's budget instead of a generous absolute: this wait runs *inside*
// RESOLVED_WORKTREE_REPO_TIMEOUT_MS, so outlasting it buys nothing — the caller has already given up
// and restored persisted rows — while turning a reusable scan into a full-budget stall that repeats
// on every TTL expiry. Subtracting keeps that invariant true by construction if either side moves.
// Why not smaller: the probe reads a subset of what the fallback scan reads, so a probe too slow to
// fit is a scan that will not fit either — waiting is strictly better right up to the budget.
// Expiring yields `null`, the existing "cannot prove unchanged" sentinel, so a real scan runs.
export const WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS =
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS - WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS

export const PTY_CONTROLLER_LIST_TIMEOUT_MS = 3000

export const PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS = 500

// Why: the renderer waits 15s; leave room for the verified failure response and release the spawn fence before its caller times out.
export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS = 12_000

// Why: tui-idle needs OSC title transitions; an unsupported CLI/plain shell never fires one, so cap at 5min to avoid indefinite hangs.
export const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export const TUI_IDLE_POLL_INTERVAL_MS = 2000

export const TUI_IDLE_QUIESCENCE_MS = 3000

// Clamp for mobileAutoRestoreFitMs: floor above the legacy 300ms debounce, 1h ceiling (a held PTY beyond that is "I forgot", not intentional).
export const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000

export const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1000
