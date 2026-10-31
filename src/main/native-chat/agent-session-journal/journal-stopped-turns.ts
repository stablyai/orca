import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { journalUserStopInForce } from './queued-message-pause'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalTombstoneRow } from './journal-row-schema'

type StoppedTurn = { turnId: string }

/** Derived once per retained root; unrelated output never reselects historical failures. */
export class JournalStoppedTurns {
  private readonly roots = new Map<string, string>()
  private readonly stopped = new Map<string, StoppedTurn>()

  remove(itemId: string, item: AgentJournalRenderItem | undefined): void {
    const turn = readAgentJournalTurn(item?.body)
    if (turn && this.roots.get(turn.turnId) === itemId) {
      this.roots.delete(turn.turnId)
    }
    this.stopped.delete(itemId)
  }

  observe(item: AgentJournalRenderItem, previous?: AgentJournalRenderItem): AgentJournalRenderItem {
    const turn = readAgentJournalTurn(item.body)
    const prior = readAgentJournalTurn(previous?.body)
    if (prior && (prior.turnId !== turn?.turnId || !isRootAgentJournalItem(item))) {
      this.remove(item.itemId, previous)
    }
    if (!turn || !isRootAgentJournalItem(item)) {
      return item
    }
    this.roots.set(turn.turnId, item.itemId)
    const fact = this.stopped.get(item.itemId)
    if (
      fact &&
      (turn.turnId !== fact.turnId ||
        turn.state !== 'interrupted' ||
        turn.outcome !== 'cancellation')
    ) {
      this.stopped.delete(item.itemId)
    }
    return item
  }

  accept(state: JournalReducerState, row: JournalTombstoneRow): void {
    const event = row.stopEvent
    if (!state.hasAppliedProviderAcceptance || event?.reason !== 'user-stop' || !event.turnId) {
      return
    }
    const itemId = this.roots.get(event.turnId)
    const item = itemId ? state.items.get(itemId) : undefined
    const turn = readAgentJournalTurn(item?.body)
    const ended = itemId ? state.turnEndedSequences.get(itemId) : undefined
    if (
      !item ||
      !turn ||
      turn.state === 'running' ||
      turn.outcome !== 'failure' ||
      ended === undefined ||
      ended >= row.seq
    ) {
      return
    }
    const fact = { turnId: turn.turnId }
    this.stopped.set(item.itemId, fact)
    const mark = state.queuePauseMarks.latestStop
    if (mark?.sequence === row.seq) {
      mark.retryOnlyTarget = fact
    }
    state.items.set(item.itemId, cancelled(item))
  }

  resolve(turnId: string): string | undefined {
    return this.roots.get(turnId)
  }

  target(turnId: string): string | undefined {
    const id = this.roots.get(turnId)
    return id && this.stopped.has(id) ? id : undefined
  }

  namesStop(state: JournalReducerState, turnId: string | undefined, sequence: number): boolean {
    const mark = journalUserStopInForce(state.queuePauseMarks, state.latestAcceptedTurnSequence)
    return (
      turnId !== undefined && mark?.sequence === sequence && mark.retryOnlyTarget?.turnId === turnId
    )
  }
}

function cancelled(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const body = item.body
  if (body.kind === 'turn') {
    return { ...item, body: { ...body, state: 'interrupted', outcome: 'cancellation' } }
  }
  return body.kind === 'status' && body.turnLifecycle
    ? {
        ...item,
        body: {
          ...body,
          turnLifecycle: { ...body.turnLifecycle, state: 'interrupted', outcome: 'cancellation' }
        }
      }
    : item
}
