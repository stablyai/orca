// What one IM-started turn shows while it runs, read from the chat's journal (never a transcript
// file): its thinking, its tool steps and the answer so far, all masked for an IM's readers.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { structuredAgentSessionTurnAssistantMessage } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { isTextBlock } from '../../shared/native-chat/native-chat-types'
import { structuredAgentSessionSendTurn } from '../../shared/structured-agent-session-send-turn'
import type { ImJournalReads } from './im-stream-follow'
import { imAnswerText, maskImText } from './im-stream-mask'
import { imStep, type ImStep } from './im-stream-step'

/** waiting: no turn is placed yet. unknown: none ever will be its own (edited, refused, taken back). */
export type ImTurnPhase = 'waiting' | 'running' | 'ended' | 'unknown'

export type ImTurnView = {
  /** The journal row of the turn shown; null while none is. */
  turnItemId: string | null
  phase: ImTurnPhase
  /** The newest thought, whole and masked; a renderer shows its tail. */
  thinking: string
  steps: ImStep[]
  /** The answer so far, masked as an answer is. */
  answer: string
  /** The turn answers another message too, so its answer is theirs as well. */
  shared: boolean
}

export const EMPTY_IM_TURN_VIEW: ImTurnView = {
  turnItemId: null,
  phase: 'waiting',
  thinking: '',
  steps: [],
  answer: '',
  shared: false
}

const UNKNOWN_IM_TURN_VIEW: ImTurnView = { ...EMPTY_IM_TURN_VIEW, phase: 'unknown' }

const rootTurnRow = (item: AgentJournalRenderItem): boolean =>
  item.body.kind === 'turn' && isRootAgentJournalItem(item)

function thoughtOf(item: AgentJournalRenderItem): string {
  return item.body.kind === 'message'
    ? item.body.blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n')
    : ''
}

/** The turn's view from its own rows, root agent only: a subagent's work stays in Orca. */
export function imTurnViewOf(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string,
  shared = false
): ImTurnView {
  let row: AgentJournalRenderItem | undefined
  let thinking = ''
  const steps: ImStep[] = []
  const own: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (item.itemId === turnItemId && rootTurnRow(item)) {
      row = item
    }
    if (
      item.turnScope?.kind !== 'turn' ||
      item.turnScope.turnItemId !== turnItemId ||
      !isRootAgentJournalItem(item)
    ) {
      continue
    }
    own.push(item)
    const { body } = item
    if (body.kind === 'message' && body.role === 'reasoning') {
      const thought = thoughtOf(item)
      thinking = thought.trim() ? thought : thinking
    } else if (body.kind === 'tool-call') {
      steps.push(imStep(item.itemId, body.name, body.input, body.state))
    }
  }
  const state = row?.body.kind === 'turn' ? row.body.state : null
  return {
    turnItemId,
    phase: state === null ? 'unknown' : state === 'running' ? 'running' : 'ended',
    // Masked whole, before any cut, so a key split by the cut is still recognized.
    thinking: maskImText(thinking),
    steps,
    answer: imAnswerText(structuredAgentSessionTurnAssistantMessage(own, turnItemId)),
    shared
  }
}

/** The turn that goes on for `turnItemId`: a turn the chat interrupted to take a message sent during
 *  it continues as the next root turn, when that turn's send came before the cut (or either time is
 *  unknown). A Stop followed by a later message never chains. */
export function imRestartedTurnItemId(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): string {
  const turns = items.filter(rootTurnRow).toSorted((a, b) => a.sequence - b.sequence)
  let at = turns.findIndex((item) => item.itemId === turnItemId)
  while (at >= 0 && at + 1 < turns.length) {
    const cut = turns[at]!.body
    const next = turns[at + 1]!.body
    if (cut.kind !== 'turn' || next.kind !== 'turn' || cut.state !== 'interrupted') {
      break
    }
    // Only the send's own time: the provider opens the turn that goes on after the cut.
    const requested = next.requestedAt
    if (requested !== undefined && cut.completedAt !== undefined && requested > cut.completedAt) {
      break
    }
    at += 1
  }
  return at >= 0 ? turns[at]!.itemId : turnItemId
}

/** The view of the turn the send `messageId` opened, or that went on for it after a mid-turn
 *  message restarted it; waiting while the send is still queued. */
export async function readImTurnView(
  reads: Pick<ImJournalReads, 'operationWindow'>,
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
    case 'shared': {
      const turn = placed.kind === 'turn' ? placed : placed.turn
      if (!turn) {
        return { ...UNKNOWN_IM_TURN_VIEW, shared: true }
      }
      const shared = placed.kind === 'shared'
      if (turn.turn.state !== 'interrupted') {
        return imTurnViewOf(snapshot.items, turn.itemId, shared)
      }
      // The window ends where the next root turn opens; the one that went on for it is past that.
      const after = await reads.operationWindow({ itemIds: [turn.itemId], withoutToolOutput: true })
      const next = imRestartedTurnItemId(after.snapshot.items, turn.itemId)
      return next === turn.itemId
        ? imTurnViewOf(snapshot.items, turn.itemId, shared)
        : imTurnViewOf(after.snapshot.items, next, true)
    }
    case 'edited':
    case 'refused':
    case 'none':
      return UNKNOWN_IM_TURN_VIEW
  }
}
