import {
  canonicalExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../src/shared/execution-host/execution-host'
import type { MobileSessionTabType } from './tabs/mobile-session-tabs'
import { parseAgentDotState, type RecentSessionCardSnapshot } from './recent-session-card-snapshot'

export const MIN_RECENT_SESSION_CARDS_DISPLAY = 1
export const MAX_RECENT_SESSION_CARDS_DISPLAY = 7
export const MAX_RECENT_SESSION_CARDS_LIMIT = 20

const TAB_TYPES = new Set<string>(['terminal', 'markdown', 'file', 'browser', 'agent-session'])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

export function clampRecentSessionCardsLimit(n: number): number {
  return Math.min(
    MAX_RECENT_SESSION_CARDS_LIMIT,
    Math.max(MIN_RECENT_SESSION_CARDS_DISPLAY, Math.round(n))
  )
}

function parseJson(raw: string | null | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function parseRecentSessionCardsMaxDisplay(raw: string | null | undefined): number | null {
  const p = parseJson(raw)
  const v = isRecord(p) ? (p.maxDisplay ?? p.recentCardsMaxDisplay) : null
  return typeof v === 'number' && Number.isFinite(v) ? clampRecentSessionCardsLimit(v) : null
}

function parseCard(v: unknown): RecentSessionCardSnapshot | null {
  if (!isRecord(v) || typeof v.tabType !== 'string' || !TAB_TYPES.has(v.tabType)) {
    return null
  }
  const [h, w, id, t] = [str(v.hostId), str(v.worktreeId), str(v.tabId), str(v.title)]
  if (!h || !w || !id || !t || !Number.isFinite(v.lastVisitedAt)) {
    return null
  }
  const [leaf, hdl] = [str(v.leafId), str(v.terminalHandle)]
  const [sid, aid, st] = [str(v.sessionId), str(v.agentId), parseAgentDotState(v.agentState)]
  const parsedExec =
    typeof v.executionHost === 'string' ? canonicalExecutionHostId(v.executionHost) : null
  const executionHost =
    parsedExec && parsedExec !== LOCAL_EXECUTION_HOST_ID ? parsedExec : undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by TAB_TYPES.has(v.tabType) above.
  const tabType = v.tabType as MobileSessionTabType
  const base = { hostId: h, worktreeId: w, worktreeName: str(v.worktreeName) ?? '', tabId: id }
  const rest = { title: t, tabType, lastVisitedAt: Number(v.lastVisitedAt) }
  const opt = Object.assign(
    {},
    executionHost && { executionHost },
    leaf && { leafId: leaf },
    hdl && { terminalHandle: hdl }
  )
  return Object.assign(
    base,
    rest,
    opt,
    sid && { sessionId: sid },
    aid && { agentId: aid },
    st && { agentState: st }
  )
}

export function parseRecentSessionCards(
  raw: string | null | undefined
): RecentSessionCardSnapshot[] {
  const p = parseJson(raw)
  const arr = Array.isArray(p)
    ? p
    : isRecord(p) && Array.isArray(p.recentCards)
      ? p.recentCards
      : []
  return arr.flatMap((i) => {
    const c = parseCard(i)
    return c ? [c] : []
  })
}
