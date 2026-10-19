import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session-provider-context'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import { appendJournalContextClear } from './journal-context-clear'
import { rewindJournalContext } from './journal-context-rewind'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalQueuedMessages } from './journal-queued-messages'

export class JournalContextController {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      writer: JournalRowWriter
      cards: JournalQueuedMessages
    }
  ) {}

  floor(): AgentJournalCursor | null {
    const state = this.deps.state()
    const sequence = latestAgentSessionContextClearSequence(state.items.values())
    return sequence > 0 ? { epoch: state.epoch, sequence } : null
  }

  clear(
    boundary: AgentSessionProviderContextBoundary,
    receipt: JournalOperationReceipt,
    settledByOp: string
  ) {
    return appendJournalContextClear({ ...this.deps, boundary, receipt, settledByOp })
  }

  rewind(
    floor: AgentJournalCursor,
    fence: number,
    items: readonly JournalReplacementItem[],
    receipt: (cursor: AgentJournalCursor) => JournalOperationReceipt
  ) {
    return rewindJournalContext({ ...this.deps, floor, fence, items, receipt })
  }
}
