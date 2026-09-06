import { AGENT_KIND_VALUES, type AgentKind } from '../../../shared/telemetry-events'

// Why: co-located with the endpoint file in userData/agent-hooks/ so hook-server cross-restart artifacts stay together.
export const LAST_STATUS_FILE_NAME = 'last-status.json'
export const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
export const ASSISTANT_MESSAGE_RETRY_MS = 50
export const CODEX_SUBAGENT_POLL_MS = 1_000
export const INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS = 15_000

// Why: starts at 2 — pre-merge v1 lacked receivedAt/stateStartedAt (never shipped); a mismatched version hydrates empty (treated as corrupt).
export const LAST_STATUS_FILE_VERSION = 2

// Why: trailing-edge debounce so a burst of hook events yields one disk write, not N; quit-time flushStatusPersistSync() guarantees the final flush.
export const STATUS_PERSIST_DEBOUNCE_MS = 250
export const TOOL_PROGRESS_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure'
])
export const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Why: bound file growth from PTYs that never re-attach; 7 days is the "still relevant?" horizon beyond which entries shouldn't resurrect on hydrate.
export const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Why: a long-closed tab can't receive status events; bound the set so it can't grow one entry per close for the whole session.
export const CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const CLOSED_AGENT_STATUS_PANE_KEYS_MAX = 1024
export const PANE_KEY_ALIASES_MAX = 1024
export const RETIRED_PANE_FENCES_MAX = 1024
