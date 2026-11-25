// What one IM-started turn shows while it runs, read from the chat's journal (never a transcript
// file): its thinking, its tool steps and the answer so far.
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { structuredAgentSessionTurnAssistantMessage } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { isTextBlock } from '../../shared/native-chat/native-chat-types'
import { structuredAgentSessionSendTurn } from '../../shared/structured-agent-session-send-turn'
import { imStep, type ImStep } from './im-stream-step'

export type ImTurnPhase = 'waiting' | 'running' | 'ended' | 'unknown'

export type ImTurnView = {
  phase: ImTurnPhase
  thinking: string
  steps: ImStep[]
  answer: string
  /** The turn shares its answer with another message's. */
  shared: boolean
}

export const EMPTY_IM_TURN_VIEW: ImTurnView = {
  phase: 'waiting',
  thinking: '',
  steps: [],
  answer: '',
  shared: false
}

function textOf(item: AgentJournalRenderItem): string {
  return item.body.kind === 'message'
    ? item.body.blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
    : ''
}

/** The turn's rows by its own items, root agent only: a subagent's work stays in Orca. */
export function imTurnViewOf(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string,
  running: boolean,
  shared: boolean
): ImTurnView {
  const own = items.filter(
    (item) =>
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId &&
      isRootAgentJournalItem(item)
  )
  const reasoning = own.filter(
    (item) => item.body.kind === 'message' && item.body.role === 'reasoning'
  )
  const steps = own.flatMap((item) =>
    item.body.kind === 'tool-call'
      ? [
          imStep(
            item.body.name,
            item.body.input,
            item.body.state === 'running'
              ? 'running'
              : item.body.state === 'failed'
                ? 'failed'
                : 'done'
          )
        ]
      : []
  )
  return {
    phase: running ? 'running' : 'ended',
    thinking: reasoning.length > 0 ? textOf(reasoning.at(-1)!) : '',
    steps,
    answer: structuredAgentSessionTurnAssistantMessage(own, turnItemId),
    shared
  }
}

/** The view of the turn the send `messageId` opened; waiting while it is still queued. */
export async function readImTurnView(
  reads: Pick<JournalSqlReads, 'operationWindow'>,
  messageId: string
): Promise<ImTurnView> {
  const { snapshot } = await reads.operationWindow({
    operationIds: [messageId],
    withoutToolOutput: true,
    throughAnchoredTurns: true
  })
  const submission =
    snapshot.submissions.find((entry) => entry.clientMessageId === messageId) ??
    snapshot.submissions.findLast((entry) => entry.queuedMessageId === messageId)
  if (!submission) {
    return EMPTY_IM_TURN_VIEW
  }
  const placed = structuredAgentSessionSendTurn(snapshot, {
    clientMessageId: messageId,
    fingerprint: submission.payloadFingerprint
  })
  switch (placed.kind) {
    case 'unsent':
    case 'pending':
      return EMPTY_IM_TURN_VIEW
    case 'turn':
      return imTurnViewOf(snapshot.items, placed.itemId, placed.turn.state === 'running', false)
    case 'shared':
      return placed.turn
        ? imTurnViewOf(
            snapshot.items,
            placed.turn.itemId,
            placed.turn.turn.state === 'running',
            true
          )
        : { ...EMPTY_IM_TURN_VIEW, phase: 'unknown', shared: true }
    case 'edited':
    case 'refused':
    case 'none':
      return { ...EMPTY_IM_TURN_VIEW, phase: 'unknown' }
  }
}
