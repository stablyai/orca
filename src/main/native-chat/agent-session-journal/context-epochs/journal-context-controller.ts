import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionProviderContextBoundary } from '../../../../shared/agent-session/agent-session-provider-context'
import { journalContextCursor } from './journal-context-cursor'
import { appendJournalContextClear } from './journal-context-clear'
import { rewindJournalContext } from './journal-context-rewind'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalEpochReplacements } from './journal-epoch-replacements'
import type { JournalOperationReceipt, JournalRowWriter } from '../writing/journal-row-writer'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalQueuedMessages } from '../queued-messages/journal-queued-messages'

export class JournalContextController {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      writer: JournalRowWriter
      cards: JournalQueuedMessages
      inputReceipt: Parameters<typeof rewindJournalContext>[0]['inputReceipt']
      /** Told in the tick each epoch replacement reaches the writer. */
      replacements: JournalEpochReplacements
    }
  ) {}

  get replacements(): JournalEpochReplacements {
    return this.deps.replacements
  }

  floor(): AgentJournalCursor | null {
    const state = this.deps.state()
    const sequence = state.queries.latestContextClearSequence(state)
    return sequence > 0 ? journalContextCursor(state, sequence) : null
  }

  clear(boundary: AgentSessionProviderContextBoundary, receipt: JournalOperationReceipt) {
    return appendJournalContextClear({ ...this.deps, boundary, receipt })
  }

  rewind(
    floor: AgentJournalCursor,
    fence: number,
    items: readonly JournalReplacementItem[],
    receipt: (cursor: AgentJournalCursor) => JournalOperationReceipt
  ) {
    const replaced = rewindJournalContext({ ...this.deps, floor, fence, items, receipt })
    this.deps.replacements.notify(replaced)
    return replaced
  }
}
