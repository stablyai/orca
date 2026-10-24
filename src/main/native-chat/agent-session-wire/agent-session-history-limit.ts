import {
  AGENT_SESSION_HISTORY_DEFAULT_LIMIT,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../../shared/agent-session-wire'

/** Clamped, never rejected: a client asking for more than the host will serve
 *  should get a smaller page and keep paging, not an error mid-scroll. */
export function resolveHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}
