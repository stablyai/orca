import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ClaudeToolUse } from '../structured/journal/claude-structured-item-translation'
import type { ClaudeOpenTurn } from '../structured/turns/claude-open-turn'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  claudeTurnLifecycleIdentity,
  type ClaudeCurrentTurn
} from '../structured/turns/claude-turn-lifecycle-item'

/**
 * The root turn the last app left running for a kept agent. Its output since then replays into this
 * record, so the turn ends once, where it began, rather than staying open beside a second one.
 */
export function keptClaudeTurn(
  items: readonly AgentJournalRenderItem[],
  providerSessionId: string
):
  | { kind: 'turn'; turn: ClaudeCurrentTurn }
  | { kind: 'command'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  | null {
  const running = items.findLast(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
  )
  const turn = running ? readAgentJournalTurn(running.body) : null
  if (!running || !turn?.turnId || turn.startedAt === undefined) {
    return null
  }
  if (
    running.itemId !==
    agentJournalItemKey(claudeTurnLifecycleIdentity(providerSessionId, turn.turnId))
  ) {
    // A slash command's row ends only through the command this app never started, so it is
    // settled as a relaunch settles it (a running row would hold back every later message).
    const identity = parseAgentJournalItemKey(running.itemId)
    const body = unverifiedTurnBody(running.body)
    return identity && body ? { kind: 'command', identity, body } : null
  }
  return {
    kind: 'turn',
    turn: {
      sessionId: providerSessionId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      ...(turn.requestedAt !== undefined ? { requestedAt: turn.requestedAt } : {}),
      userItemId: turn.userItemId ?? running.itemId
    }
  }
}

function unverifiedTurnBody(body: AgentJournalItemBody): AgentJournalItemBody | null {
  if (body.kind === 'turn') {
    return { ...body, state: 'unverifiable' }
  }
  return body.kind === 'status' && body.turnLifecycle
    ? { ...body, turnLifecycle: { ...body.turnLifecycle, state: 'unverifiable' } }
    : null
}

/**
 * Tool calls still running when the last app quit, from their saved rows: a replay that no longer
 * reaches back to a call's start (the host let it go at its cap) still ends it under its own name.
 */
export function keptClaudeToolCalls(items: readonly AgentJournalRenderItem[]): ClaudeToolUse[] {
  return items.flatMap((item) =>
    item.body.kind === 'tool-call' && item.body.state === 'running' && item.body.callId
      ? [{ id: item.body.callId, name: item.body.name, input: item.body.input }]
      : []
  )
}

export function adoptKeptClaudeWork(
  open: Pick<ClaudeOpenTurn, 'adoptKept'>,
  tools: Map<string, ClaudeToolUse>,
  kept: { turn: ClaudeCurrentTurn | null; tools: readonly ClaudeToolUse[] }
): void {
  if (kept.turn) {
    open.adoptKept(kept.turn)
  }
  for (const tool of kept.tools) {
    if (!tools.has(tool.id)) {
      tools.set(tool.id, tool)
    }
  }
}
