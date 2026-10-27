import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { hookAuthority } from './agent-state-rules/agent-state-rules-engine'
import { selectFreshExplicitAgentStatusRow } from './runtime-hook-agent-row-selection'
import { terminalHostConnectionMatches } from './orchestration/worker-provider-session'

type HookTurnState = 'done' | 'working' | 'permission'

/** The main agent's hook turn plus permission-arbiter blocked verdict, with a generic prompt for hook waits lacking recognized text. */
export type TuiIdleHookTurn = {
  state: HookTurnState
  blockedReason: RuntimeTerminalWaitBlockedReason | null
  taskWakeupPending?: true
  /** When a fresh `done`'s turn has had time to paint its last frame. */
  finalFrameAt?: number
}

// Why: Codex runs its Stop hook before it paints the turn's last frame, which can be its plan menu.
const TURN_END_FINAL_FRAME_MS = 750
// Why: Codex opens its plan menu only after a turn that rendered a proposed plan; no hook field says so.
const CODEX_PROPOSED_PLAN_HEADER = 'Proposed Plan'

/** Scans newest-first so the common hit (this turn's plan) returns early. */
export function retainedTailIncludes(
  lines: readonly string[],
  partialLine: string,
  text: string
): boolean {
  if (partialLine.includes(text)) {
    return true
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(text)) {
      return true
    }
  }
  return false
}

/** Read the lead's own turn: child completion cannot end it, but child permission waits still block. An ended lead can accept input while children run. */
export function hookLeadTurnState(
  row: Pick<AgentStatusIpcPayload, 'state' | 'mainAgent' | 'sessionBoundary'>
): HookTurnState | null {
  // Why no answer: a session start is not a turn end, and some agents post it before their
  // composer accepts input, so startup readiness stays with the screen and text rules.
  if (row.state === 'done' && row.sessionBoundary === true) {
    return null
  }
  if (row.state === 'waiting' || row.state === 'blocked') {
    return 'permission'
  }
  const lead = row.mainAgent?.state ?? row.state
  return lead === 'done' || lead === 'working' ? lead : 'permission'
}

export type TuiIdleHookTurnRead = {
  agent: TuiAgent
  handles: Iterable<string>
  paneKeys: Iterable<string>
  hookRows: readonly AgentStatusIpcPayload[]
  connectionId?: string | null
  wslDistro?: string | null
  launchToken?: string | null
  titleObservedAtEpochMs?: number | null
  hasExplicitIdleTitle?: boolean
  /** When the PTY respawned: every row from before it is the previous process's. */
  respawnedAt?: number
  /** When input last reached the pane, typed or sent: a `done` from before it cannot speak for
   *  the turn that input may have started (or the agent it restarted), whose first hook can still
   *  be in flight. */
  lastInputAt?: number | null
  /** Whether the pane's retained output holds `text`; read only while a fresh `done` may precede a menu. */
  tailIncludes?: (text: string) => boolean
  /** The existing permission arbiter, given the turn as the pane's explicit status. */
  resolveBlockedText(
    status: HookTurnState,
    row: AgentStatusIpcPayload
  ): RuntimeTerminalWaitBlockedReason | null
}

/** Read the freshest pane/handle-joined hook row for this agent and process; unjoinable, stale or foreign rows leave other lanes to decide. */
export function readTuiIdleHookTurn(read: TuiIdleHookTurnRead): TuiIdleHookTurn | null {
  const row = selectFreshExplicitAgentStatusRow(read)
  if (!row || row.agentType !== read.agent || row.receivedAt < (read.respawnedAt ?? -1)) {
    return null
  }
  const state = hookLeadTurnState(row)
  const predatesInput = row.receivedAt < (read.lastInputAt ?? -1)
  if (state === null || (state === 'done' && predatesInput)) {
    return null
  }
  const blockedReason = read.resolveBlockedText(state, row)
  // Why the hook alone blocks: a question or custom modal paints no dialog text the arbiter knows,
  // and these hooks report its answer. Input since may have answered it before the hook arrived.
  const taskWakeupPending =
    read.agent === 'claude' &&
    row.state !== 'done' &&
    (row.claudeTaskWakeupPending === 'notification' ||
      (row.claudeTaskWakeupPending === 'finishing-turn' &&
        !(
          read.hasExplicitIdleTitle &&
          typeof read.titleObservedAtEpochMs === 'number' &&
          read.titleObservedAtEpochMs > (row.turnStartedAt ?? row.receivedAt)
        ))) &&
    row.observation?.origin === 'hook' &&
    row.providerSession?.key === 'session_id' &&
    terminalHostConnectionMatches(row.connectionId, read.connectionId ?? null, read.wslDistro) &&
    (!read.launchToken || row.launchToken === read.launchToken)
  const finalFrameAt = row.receivedAt + TURN_END_FINAL_FRAME_MS
  const finalFramePending =
    state === 'done' &&
    hookAuthority(read.agent) === 'turn-end' &&
    Date.now() < finalFrameAt &&
    read.tailIncludes?.(CODEX_PROPOSED_PLAN_HEADER) === true
  return {
    state,
    ...(taskWakeupPending ? { taskWakeupPending: true as const } : {}),
    ...(finalFramePending ? { finalFrameAt } : {}),
    blockedReason:
      blockedReason ??
      (state === 'permission' && !predatesInput ? 'agent-interactive-prompt' : null)
  }
}

/** The tui-idle verdicts the hook lane can reach (a subset of `TuiIdleVerdict`). */
export type TuiIdleHookVerdict =
  | { kind: 'ready-strong' }
  | { kind: 'working' }
  | { kind: 'blocked'; reason: RuntimeTerminalWaitBlockedReason }
  | { kind: 'pending'; quietForeground: 'closed'; recheckAt?: number }

/** Authoritative hooks work headless without window-ready titles (#16095). Arbitrate lingering denied-dialog text against the fresh turn; absent rows leave other tiers. */
export function evaluateHookTurn(
  agent: TuiAgent | null | undefined,
  readHookTurn: () => TuiIdleHookTurn | null
): TuiIdleHookVerdict | null {
  // A ready composer can still owe a task wake-up; only that owner-produced fact vetoes Claude rest.
  if (agent === 'claude') {
    const turn = readHookTurn()
    return turn?.taskWakeupPending
      ? turn.blockedReason
        ? { kind: 'blocked', reason: turn.blockedReason }
        : { kind: 'working' }
      : null
  }
  const authority = hookAuthority(agent)
  if (authority === 'identity-only') {
    return null
  }
  const turn = readHookTurn()
  // Why only a done for `turn-end`: an end that posts nothing leaves the row working forever.
  if (authority === 'turn-end' && turn?.state !== 'done') {
    return null
  }
  if (turn?.blockedReason) {
    return { kind: 'blocked', reason: turn.blockedReason }
  }
  switch (turn?.state) {
    case undefined:
      return null
    case 'done':
      return turn.finalFrameAt
        ? { kind: 'pending', quietForeground: 'closed', recheckAt: turn.finalFrameAt }
        : { kind: 'ready-strong' }
    case 'working':
      return { kind: 'working' }
    case 'permission':
      // Why pending: input after the wait opened may have answered it; the next hook decides.
      return { kind: 'pending', quietForeground: 'closed' }
  }
}
