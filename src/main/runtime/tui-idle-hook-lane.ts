import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { hookAuthority } from './agent-state-rules/agent-state-rules-engine'
import { selectFreshExplicitAgentStatusRow } from './runtime-hook-agent-row-selection'

type HookTurnState = 'done' | 'working' | 'permission'

/**
 * The main agent's turn as the hook server's store last saw it for one pane, and the permission
 * arbiter's verdict on the pane's blocked text with that turn as its explicit status (or, for a
 * wait the hook reports with no text the arbiter knows, a generic interactive prompt).
 */
export type TuiIdleHookTurn = {
  state: HookTurnState
  blockedReason: RuntimeTerminalWaitBlockedReason | null
}

/**
 * Reads the main agent's turn off its row. Why the main agent's own state: the row's combined
 * state folds child work in, and a subagent finishing must not end the lead turn (#6011); a
 * child's permission wait still blocks, since its prompt is on the pane. A lead turn that ended
 * reads done even while a subagent runs: its composer takes input then, as the screen rules read it.
 */
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
  /** When the PTY respawned: every row from before it is the previous process's. */
  respawnedAt?: number
  /** When input last reached the pane, typed or sent: a `done` from before it cannot speak for
   *  the turn that input may have started (or the agent it restarted), whose first hook can still
   *  be in flight. */
  lastInputAt?: number | null
  /** The existing permission arbiter, given the turn as the pane's explicit status. */
  resolveBlockedText(
    status: HookTurnState,
    row: AgentStatusIpcPayload
  ): RuntimeTerminalWaitBlockedReason | null
}

/**
 * The pane's freshest hook row, joined on its pane keys and terminal handles. A pane neither
 * reaches (a PTY created with no pane key whose agent never posted under one) has no answer, and
 * neither does a row another agent or an earlier process wrote: the caller's other lanes decide.
 */
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
  return {
    state,
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
  | { kind: 'pending'; quietForeground: 'closed' }

/**
 * Tier 0 of tui-idle-evidence.ts for an agent whose hooks are trusted (`profile.hooks`). Why ahead
 * of every rule: they reach a headless host, where the `<Agent> ready` titles the window writes
 * never appear (#16095). Why the arbiter judges the blocked text: a denied prompt's dialog lingers
 * in the line tail after the hook says the turn moved on. No fresh row (startup, before the first
 * prompt, or an unjoinable pane) leaves the other tiers.
 */
export function evaluateHookTurn(
  agent: TuiAgent | null | undefined,
  readHookTurn: () => TuiIdleHookTurn | null
): TuiIdleHookVerdict | null {
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
      return { kind: 'ready-strong' }
    case 'working':
      return { kind: 'working' }
    case 'permission':
      // Why pending: input after the wait opened may have answered it; the next hook decides.
      return { kind: 'pending', quietForeground: 'closed' }
  }
}
