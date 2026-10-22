import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycleState,
  type AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { mspItemIdentity } from './msp-journal-translation'
import type { MspTurnEvent } from './msp-protocol'

export class MspTurnTranslator {
  private readonly opened = new Set<string>()

  constructor(
    private readonly sink: StructuredAgentSessionEventSink,
    private readonly sessionId: string,
    private readonly now: () => number
  ) {}

  openTurn(turnId: string, input: { requestedAt?: number; userItemId?: string } = {}): void {
    if (this.opened.has(turnId)) {
      return
    }
    this.opened.add(turnId)
    this.sink.tryAppendItem?.(
      mspItemIdentity(this.sessionId, `turn:${turnId}`),
      {
        kind: 'turn',
        turnId,
        state: 'running' as AgentJournalTurnLifecycleState,
        startedAt: this.now(),
        ...(input.requestedAt !== undefined ? { requestedAt: input.requestedAt } : {}),
        ...(input.userItemId !== undefined ? { userItemId: input.userItemId } : {})
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    this.sink.publish()
  }

  closeTurn(event: MspTurnEvent, outcome?: AgentJournalTurnOutcome): void {
    const identity = mspItemIdentity(this.sessionId, `turn:${event.turnId}`)
    const sink = this.sink
    if (!sink.tryReviseResolvedItem) {
      return
    }
    sink.tryReviseResolvedItem(
      512,
      (journal) => {
        const current = journal.itemBody(agentJournalItemKey(identity))
        if (!current || current.kind !== 'turn') {
          return null
        }
        return {
          identity,
          body: {
            ...current,
            state: 'completed' as AgentJournalTurnLifecycleState,
            completedAt: this.now(),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(outcome ? { outcome } : {})
          }
        }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    sink.publish()
  }

  failTurn(turnId: string, reason: string): void {
    const identity = mspItemIdentity(this.sessionId, `turn:${turnId}`)
    const sink = this.sink
    if (!sink.tryReviseResolvedItem) {
      return
    }
    sink.tryReviseResolvedItem(
      512,
      (journal) => {
        const current = journal.itemBody(agentJournalItemKey(identity))
        if (!current || current.kind !== 'turn') {
          return null
        }
        return {
          identity,
          body: {
            ...current,
            state: 'interrupted' as AgentJournalTurnLifecycleState,
            completedAt: this.now(),
            outcome: 'cancellation' as AgentJournalTurnOutcome
          }
        }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    void reason
    sink.publish()
  }
}
