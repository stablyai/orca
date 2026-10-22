import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { mspItemIdentity } from './msp-journal-translation'

export type MspPromptResolution = {
  state: 'resolved' | 'cancelled'
  selectedOptionId: string | null
}

export class MspPromptTranslator {
  constructor(
    private readonly sink: StructuredAgentSessionEventSink,
    private readonly sessionId: string,
    private readonly turnScope: (turnId: string) => { kind: 'turn'; turnItemId: string },
    private readonly now: () => number
  ) {}

  writeApprovalRow(
    itemId: string,
    turnId: string,
    row: Extract<AgentJournalItemBody, { kind: 'approval' }>
  ): void {
    this.sink.tryAppendItem?.(mspItemIdentity(this.sessionId, itemId), row, {
      turnScope: this.turnScope(turnId)
    })
    this.sink.publish()
  }

  writeQuestionRow(
    itemId: string,
    turnId: string,
    row: Extract<AgentJournalItemBody, { kind: 'question' }>
  ): void {
    this.sink.tryAppendItem?.(mspItemIdentity(this.sessionId, itemId), row, {
      turnScope: this.turnScope(turnId)
    })
    this.sink.publish()
  }

  resolvePromptRow(itemId: string, turnId: string, resolution: MspPromptResolution): void {
    const identity = mspItemIdentity(this.sessionId, itemId)
    const sink = this.sink
    if (!sink.tryReviseResolvedItem) {
      return
    }
    sink.tryReviseResolvedItem(
      1024,
      (journal) => {
        const current = journal.itemBody(agentJournalItemKey(identity))
        if (!current || (current.kind !== 'approval' && current.kind !== 'question')) {
          return null
        }
        return {
          identity,
          body: {
            ...current,
            resolution: {
              ...current.resolution,
              state: resolution.state,
              selectedOptionId: resolution.selectedOptionId,
              resolvedBy: 'muse',
              resolvedAt: this.now()
            }
          }
        }
      },
      { turnScope: this.turnScope(turnId) }
    )
    sink.publish()
  }
}
