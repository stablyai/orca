import { agentJournalSubmissionProvenUnwritten } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalItemExecutionFence } from './journal-item-provenance'

export type JournalCancellationTarget = {
  ownerFence: number
  turnId?: string
  clientMessageId?: string
}

export function turnOpeningClientId(
  state: Pick<JournalReducerState, 'aliases'>,
  userItemId?: string
): string | undefined {
  if (userItemId === undefined) {
    return undefined
  }
  const identity = parseAgentJournalItemKey(state.aliases.get(userItemId) ?? userItemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? identity.clientMessageId
    : undefined
}

/** Derived active executions only; historical turns and resolved handovers never enter Stop capture. */
export class JournalCancellationTargets {
  private turns: Record<string, JournalCancellationTarget> = {}
  private openers: Record<string, number> = {}

  turn(turnId: string): JournalCancellationTarget | undefined {
    return this.turns[`turn:${turnId}`]
  }

  observeTurn(state: JournalReducerState, item: AgentJournalRenderItem): void {
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      return
    }
    const clientMessageId = turnOpeningClientId(state, turn.userItemId)
    if (clientMessageId !== undefined) {
      delete this.openers[`send:${clientMessageId}`]
    }
    if (turn.state !== 'running' && turn.state !== 'unverifiable') {
      delete this.turns[`turn:${turn.turnId}`]
      return
    }
    this.turns[`turn:${turn.turnId}`] = {
      turnId: turn.turnId,
      ownerFence: journalItemExecutionFence(state, item.itemId) ?? 0,
      ...(clientMessageId !== undefined ? { clientMessageId } : {})
    }
  }

  observeSubmission(
    state: JournalReducerState,
    submission: AgentJournalSubmission,
    item?: AgentJournalRenderItem
  ): void {
    const id = submission.clientMessageId
    if (
      (submission.dispatchState === 'rejected' &&
        agentJournalSubmissionProvenUnwritten(submission)) ||
      item?.turnScope?.kind === 'turn'
    ) {
      delete this.openers[`send:${id}`]
    } else if (submission.handedOverAt !== undefined || !submission.handoverRecorded) {
      this.openers[`send:${id}`] =
        journalItemExecutionFence(state, agentJournalSubmissionKey(id)) ?? submission.fence
    }
  }

  retainOpener(clientMessageId: string, ownerFence: number): void {
    this.openers[`send:${clientMessageId}`] = ownerFence
  }

  remove(turnId?: string, clientMessageId?: string): void {
    if (turnId !== undefined) {
      delete this.turns[`turn:${turnId}`]
    }
    if (clientMessageId !== undefined) {
      delete this.openers[`send:${clientMessageId}`]
    }
  }

  capture(ownerFence: number, turnId?: string): JournalCancellationTarget[] {
    if (turnId !== undefined) {
      const target = this.turns[`turn:${turnId}`]
      return target ? [target] : []
    }
    return [
      ...Object.values(this.turns).filter((t) => t.ownerFence === ownerFence),
      ...Object.entries(this.openers)
        .filter(([, fence]) => fence === ownerFence)
        .map(([key]) => ({ ownerFence, clientMessageId: key.slice(5) }))
    ]
  }
}

export function restoreJournalCancellationTargets(state: JournalReducerState): void {
  const targets = new JournalCancellationTargets()
  state.derivedTurnScope.cancellations = targets
  for (const submission of state.submissions.values()) {
    targets.observeSubmission(
      state,
      submission,
      state.items.get(agentJournalSubmissionKey(submission.clientMessageId))
    )
  }
  for (const item of state.items.values()) {
    targets.observeTurn(state, item)
  }
  for (const entry of state.queuePauseMarks.pendingCancellations ?? []) {
    if (entry.target?.turnId === undefined && entry.target?.clientMessageId !== undefined) {
      targets.retainOpener(entry.target.clientMessageId, entry.target.ownerFence)
    }
  }
}
