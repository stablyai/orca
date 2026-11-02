import { AGENT_STATUS_HYDRATE_MAX_AGE_MS } from '../../../shared/agent-status-freshness'
import { AGENT_KIND_VALUES, type AgentKind } from '../../../shared/telemetry-events'

export const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
export const ASSISTANT_MESSAGE_RETRY_MS = 50
export const CODEX_SUBAGENT_POLL_MS = 1_000

// Version 1 lacked ordering clocks; mismatched caches hydrate empty.
export const LAST_STATUS_FILE_VERSION = 2

// Throttle ordinary writes; authority changes bypass the window and quit flushes synchronously.
export const STATUS_PERSIST_MIN_INTERVAL_MS = 5_000
export const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Expire orphaned PTY rows so old work cannot resurrect on hydration.
export const HYDRATE_MAX_AGE_MS = AGENT_STATUS_HYDRATE_MAX_AGE_MS

// Bound closed-tab memory across long sessions.
export const CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const CLOSED_AGENT_STATUS_PANE_KEYS_MAX = 1024
export const PANE_KEY_ALIASES_MAX = 1024
export const RETIRED_PANE_FENCES_MAX = 1024
