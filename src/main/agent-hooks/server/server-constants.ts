import { AGENT_DONE_QUIET_MS } from '../../../shared/agent-status/lifecycle/agent-transitions'
import {
  AGENT_KIND_VALUES,
  type AgentKind
} from '../../../shared/telemetry/schemas/telemetry-property-schemas'

export const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
export const ASSISTANT_MESSAGE_RETRY_MS = 50
// Copilot can write a turn's reply well after agentStop (a Fusion answer up to ~370 ms later).
// Retries end within the done quiet window, so a reply they find still reaches the banner and push.
export const COPILOT_STOP_REPLY_RETRY_ATTEMPTS = Math.floor(
  AGENT_DONE_QUIET_MS / ASSISTANT_MESSAGE_RETRY_MS
)
export const CODEX_SUBAGENT_POLL_MS = 1_000

// Version 1 lacked ordering clocks; mismatched caches hydrate empty.
export const LAST_STATUS_FILE_VERSION = 2

// Stream checkpoints can wait; prompt/completion facts and authority changes bypass this window.
export const STATUS_PERSIST_MIN_INTERVAL_MS = 3 * 60_000
// A failed save (often another connection's lock) retries on its own short backoff.
export const STATUS_PERSIST_RETRY_MIN_MS = 1_000
export const STATUS_PERSIST_RETRY_MAX_MS = 30_000
// Routine saves never wait on a lock; quit-time flushes wait at most this long.
export const STATUS_FLUSH_BUSY_TIMEOUT_MS = 200
export const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Expire orphaned PTY rows so old work cannot resurrect on hydration.

// Bound closed-tab memory across long sessions.
export const CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const CLOSED_AGENT_STATUS_PANE_KEYS_MAX = 1024
export const PANE_KEY_ALIASES_MAX = 1024
export const RETIRED_PANE_FENCES_MAX = 1024
