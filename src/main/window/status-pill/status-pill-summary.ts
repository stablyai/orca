import type { AgentStatusIpcPayload, AgentStatusState } from '../../../shared/agent-status-types'
import type {
  StatusPillAgentRow,
  StatusPillPendingQuestion,
  StatusPillSummary
} from '../../../shared/status-pill-preload-api'

export type { StatusPillSummary }

/** Window after which a `done` agent stops contributing to the activity label.
 *  Mirrors `AGENT_STATUS_STALE_AFTER_MS` so the pill and sidebar share the same
 *  notion of "still relevant". */
const STALE_AFTER_MS = 30 * 60 * 1000

const EMPTY_SUMMARY: StatusPillSummary = {
  working: 0,
  blocked: 0,
  waiting: 0,
  recentDone: 0,
  hasAnyActivity: false,
  activityLabel: '',
  activityPaneKey: null,
  activePaneKey: null,
  activeTabId: null
}

export function computeStatusPillSummary(
  entries: AgentStatusIpcPayload[],
  now: number = Date.now()
): StatusPillSummary {
  if (!Array.isArray(entries) || entries.length === 0) {
    return EMPTY_SUMMARY
  }

  let working = 0
  let blocked = 0
  let waiting = 0
  let recentDone = 0
  let lead: AgentStatusIpcPayload | null = null
  let pendingQuestion: AgentStatusIpcPayload | null = null

  for (const entry of entries) {
    if (!entry || entry.providerSessionOnly === true) {
      // Why: providerSessionOnly frames carry no status UI; they refresh resume
      // identity only. Skipping keeps the pill from counting idle session pings
      // as activity.
      continue
    }
    const age = now - (entry.receivedAt ?? entry.stateStartedAt ?? 0)
    const fresh = age >= 0 && age <= STALE_AFTER_MS
    if (!fresh) {
      continue
    }
    switch (entry.state as AgentStatusState) {
      case 'working':
        working += 1
        break
      case 'blocked':
        blocked += 1
        break
      case 'waiting':
        waiting += 1
        break
      case 'done':
        recentDone += 1
        break
    }
    // Why: pick the pending question with the strongest state signal. A
    // blocked pane (Copilot permission_prompt) outranks a generic waiting
    // pane because it is more likely to need urgent attention.
    if (
      typeof entry.interactivePrompt === 'string' &&
      entry.interactivePrompt.length > 0 &&
      (entry.state === 'waiting' || entry.state === 'blocked') &&
      isMoreRelevantPendingQuestion(entry, pendingQuestion)
    ) {
      pendingQuestion = entry
    }
    // Why: pick the "most relevant" pane for the activity label. Working >
    // blocked > waiting > done (most recently received wins ties).
    if (isMoreRelevantLead(entry, lead)) {
      lead = entry
    }
  }

  const totalActive = working + blocked + waiting
  if (totalActive === 0 && recentDone === 0 && !pendingQuestion) {
    return EMPTY_SUMMARY
  }

  const base: StatusPillSummary = {
    working,
    blocked,
    waiting,
    recentDone,
    hasAnyActivity: totalActive > 0,
    activityLabel: '',
    activityPaneKey: null,
    activePaneKey: null,
    activeTabId: null
  }

  if (lead) {
    base.activityLabel = buildActivityLabel(lead)
    base.activityPaneKey = lead.paneKey
    base.activePaneKey = lead.paneKey
    base.activeTabId = lead.tabId ?? null
  }

  if (pendingQuestion) {
    base.pendingQuestion = buildPendingQuestion(pendingQuestion)
  }

  return base
}

const STATE_PRIORITY: Record<AgentStatusState, number> = {
  working: 0,
  blocked: 1,
  waiting: 2,
  done: 3
}

function isMoreRelevantLead(
  candidate: AgentStatusIpcPayload,
  current: AgentStatusIpcPayload | null
): boolean {
  if (!current) {
    return true
  }
  const candPri = STATE_PRIORITY[candidate.state as AgentStatusState] ?? 99
  const curPri = STATE_PRIORITY[current.state as AgentStatusState] ?? 99
  if (candPri !== curPri) {
    return candPri < curPri
  }
  // Why: same priority → most recently received update wins so the label
  // tracks the latest pane to fire a hook event.
  return (candidate.receivedAt ?? 0) >= (current.receivedAt ?? 0)
}

function isMoreRelevantPendingQuestion(
  candidate: AgentStatusIpcPayload,
  current: AgentStatusIpcPayload | null
): boolean {
  if (!current) {
    return true
  }
  // Why: a blocked permission prompt is more urgent than a generic waiting
  // question; pick it first. Among same-priority pending questions, the most
  // recently received one wins so the card does not flicker between agents.
  const candPri = STATE_PRIORITY[candidate.state as AgentStatusState] ?? 99
  const curPri = STATE_PRIORITY[current.state as AgentStatusState] ?? 99
  if (candPri !== curPri) {
    return candPri < curPri
  }
  return (candidate.receivedAt ?? 0) >= (current.receivedAt ?? 0)
}

function buildPendingQuestion(entry: AgentStatusIpcPayload): StatusPillPendingQuestion {
  return {
    paneKey: entry.paneKey,
    terminalHandle: entry.terminalHandle,
    agentLabel: formatAgentType(entry.agentType ?? 'agent'),
    interactivePrompt: entry.interactivePrompt ?? '',
    toolName: typeof entry.toolName === 'string' ? entry.toolName : undefined,
    tabId: entry.tabId
  }
}

function buildActivityLabel(entry: AgentStatusIpcPayload): string {
  const agentType = entry.agentType ? formatAgentType(entry.agentType) : 'agent'
  const prompt = truncate(cleanString(entry.prompt), 40)
  const tool = truncate(cleanString(entry.toolName), 28)
  if (prompt && tool) {
    return `${agentType} — ${prompt} · ${tool}`
  }
  if (prompt) {
    return `${agentType} — ${prompt}`
  }
  if (tool) {
    return `${agentType} · ${tool}`
  }
  return agentType
}

function formatAgentType(agentType: string): string {
  // Why: well-known internal ids like "claude" or "openclaude" read better
  // capitalized in the pill; unknown agents pass through unchanged so custom
  // agent names a user configured stay as they wrote them.
  const lower = agentType.toLowerCase()
  const wellKnown: Record<string, string> = {
    claude: 'Claude',
    openclaude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    copilot: 'Copilot',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    aider: 'Aider',
    droid: 'Droid',
    amp: 'Amp',
    grok: 'Grok'
  }
  return wellKnown[lower] ?? agentType
}

function cleanString(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Build the per-pane rows the expanded multi-agent panel renders. Same
 *  freshness window as the summary so the two views stay in sync. */
export function computeStatusPillAgentRows(
  entries: AgentStatusIpcPayload[],
  now: number = Date.now()
): StatusPillAgentRow[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }
  const rows: StatusPillAgentRow[] = []
  for (const entry of entries) {
    if (!entry || entry.providerSessionOnly === true) {
      continue
    }
    const age = now - (entry.receivedAt ?? entry.stateStartedAt ?? 0)
    const fresh = age >= 0 && age <= STALE_AFTER_MS
    if (!fresh) {
      continue
    }
    rows.push({
      paneKey: entry.paneKey,
      agentType: entry.agentType ?? 'agent',
      state: entry.state,
      prompt: cleanString(entry.prompt),
      toolName: cleanString(entry.toolName),
      // Why: main has no durable view of the user's terminal label; the
      // renderer-side focus path resolves the terminal name from the
      // main-window store. Keep these null here so the pill renderer can
      // render a generic fallback rather than guess.
      terminalName: null,
      worktreeLabel: entry.worktreeId ?? null,
      receivedAt: entry.receivedAt ?? 0,
      tabId: entry.tabId ?? null,
      // Why: carry the raw interactive prompt envelope so the expanded panel
      // can render the live question card for this specific pane (the summary
      // only carries the single most-urgent pending question across all panes).
      interactivePrompt:
        typeof entry.interactivePrompt === 'string' && entry.interactivePrompt.length > 0
          ? entry.interactivePrompt
          : undefined
    })
  }
  // Why: most-relevant-first ordering so the panel surfaces the pane the user
  // most likely wants to act on at the top. Matches summary's lead selection.
  rows.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state as AgentStatusState] ?? 99
    const pb = STATE_PRIORITY[b.state as AgentStatusState] ?? 99
    if (pa !== pb) {
      return pa - pb
    }
    return (b.receivedAt ?? 0) - (a.receivedAt ?? 0)
  })
  return rows
}
