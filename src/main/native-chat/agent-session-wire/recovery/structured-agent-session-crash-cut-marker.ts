// After a crash, settlement already wrote what the dead run left: the cut turn, its cancelled prompts
// and its lost live work. Read those facts back into the offer a quit would have recorded.

import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalRestartCut } from '../../agent-session-journal/journal-sql-restart-cut'
import {
  AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS,
  type AgentSessionRestartPrompt,
  type AgentSessionRestartTask
} from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-activity'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionProviderHandleRoot } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { orcaStopCauseOfRow } from '../../../../shared/native-chat/transcript/continuation/native-chat-orca-stop-cut'
import {
  isBackgroundTaskBlock,
  isSubagentBlock,
  isSubagentGroupBlock
} from '../../../../shared/native-chat/native-chat-types'

/** One offer per crashed run: the same run re-derives the same witness on every start. */
export function crashCutTeardownId(runtime: string): string {
  return `crash:${runtime}`
}

function label(text: string | undefined): string {
  const trimmed = text?.trim() ?? ''
  return trimmed.length > AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH - 1)}…`
    : trimmed
}

function inTurn(item: AgentJournalRenderItem, turnItemId: string): boolean {
  return item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId
}

/** Prompts the settlement cancelled: the person was being asked when Orca went away. */
function cancelledPrompts(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): AgentSessionRestartPrompt[] {
  return items
    .filter((item) => inTurn(item, turnItemId))
    .flatMap(({ body }): AgentSessionRestartPrompt[] =>
      body.kind === 'approval' && body.resolution.state === 'cancelled'
        ? [{ kind: 'approval', label: label(body.displayName ?? body.title) }]
        : body.kind === 'question' && body.resolution.state === 'cancelled'
          ? [{ kind: 'question', label: label(body.question) }]
          : []
    )
    .slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS)
}

/** Live work the settlement marked lost, including a background task the turn left running. */
function lostTasks(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): AgentSessionRestartTask[] {
  return items
    .filter((item) => inTurn(item, turnItemId))
    .flatMap(({ body }): AgentSessionRestartTask[] =>
      body.kind !== 'message'
        ? []
        : body.blocks.flatMap((block): AgentSessionRestartTask[] => {
            if (isBackgroundTaskBlock(block)) {
              return block.state === 'unverifiable'
                ? [{ kind: block.kind, label: label(block.label) }]
                : []
            }
            if (isSubagentBlock(block)) {
              return block.state === 'unverifiable'
                ? [{ kind: 'agent', label: label(block.label) }]
                : []
            }
            return isSubagentGroupBlock(block)
              ? block.agents
                  .filter((agent) => agent.state === 'unverifiable')
                  .map((agent) => ({ kind: 'agent' as const, label: label(agent.label) }))
              : []
          })
    )
    .slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS)
}

/** The offer for a chat whose run crashed, or null when this start's settlement cut nothing to carry on. */
export function crashCutResumeMarker(input: {
  sessionId: string
  cut: JournalRestartCut
  record: Pick<AgentSessionRecord, 'providerHandleChain' | 'providerContextBoundary'>
  crashedRuntime: string
  /** Only what settlement wrote since then counts: an older crash's rows were offered by its start. */
  settledSince: number
}): AgentSessionResumeMarker | null {
  const { turn: turnItem, movedOn, cursor } = input.cut
  const settled = input.cut.recovered.filter(
    (item) => (item.recoveredAt ?? -1) >= input.settledSince
  )
  const turn = readAgentJournalTurn(turnItem?.body)
  const head = agentSessionProviderHandleChainHead(input.record.providerHandleChain)
  // A request after the newest turn means the chat moved on.
  if (!turnItem || !turn || !head || movedOn || settled.length === 0) {
    return null
  }
  const prompts = cancelledPrompts(settled, turnItem.itemId)
  const tasks = lostTasks(settled, turnItem.itemId)
  // Only this turn's cut counts; a cut turn is itself settled, so a row outside it adds nothing.
  const provenCut =
    settled.some((item) => inTurn(item, turnItem.itemId) && orcaStopCauseOfRow(item) === 'crash') ||
    (settled.includes(turnItem) && turn.state === 'interrupted')
  // No proof its agent exited: it may still be running, so only a person may continue it.
  const exitUnproven = !provenCut && settled.includes(turnItem) && turn.state === 'unverifiable'
  const leadCut = provenCut || exitUnproven
  // A finished turn with nothing left running was not interrupted.
  if (!leadCut && tasks.length === 0) {
    return null
  }
  return {
    sessionId: input.sessionId,
    work: { kind: 'turn', id: turn.turnId },
    latestUserItemId: turn.userItemId ?? null,
    recordedAt: Math.max(...settled.map((item) => item.recoveredAt ?? 0)),
    // Settlement stamps the cut with how its run ended: a quit killed mid-teardown reads as a quit.
    trigger:
      settled.flatMap(
        (item) => (inTurn(item, turnItem.itemId) && orcaStopCauseOfRow(item)) || []
      )[0] ?? 'crash',
    teardownId: crashCutTeardownId(input.crashedRuntime),
    journalCursor: cursor,
    ...(input.record.providerContextBoundary
      ? { contextClearOperationId: input.record.providerContextBoundary.operationId }
      : {}),
    providerHandleRoot: agentSessionProviderHandleRoot(head.handle),
    ...(exitUnproven ? { exitUnproven: true as const } : {}),
    activity: {
      state: prompts.length > 0 ? 'blocked' : leadCut ? 'working' : 'done',
      prompts,
      tasks
    }
  }
}
