import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalReducerState } from './journal-reducer'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import { rewindJournalContext } from './journal-context-rewind'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      identity: AgentSessionJournalIdentity
      now: () => number
      mintEpoch: () => string
      database: () => JournalHostDatabase
      state: () => JournalReducerState
      writer: JournalRowWriter
      adopt: (loaded: JournalLoad) => void
    }
  ) {}

  start(reason: AgentJournalEpochReason, fence: number): void {
    publishNewEpoch({
      database: this.deps.database(),
      identity: this.deps.identity,
      epoch: this.deps.mintEpoch(),
      reason,
      fence,
      now: this.deps.now(),
      onPublished: this.deps.adopt
    })
  }

  roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.replace(reason, fence, [])
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[],
    receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt,
    providerHandle = agentSessionJournalProviderHandle(this.deps.identity)
  ): Promise<AgentJournalCursor> {
    return rewindJournalContext({
      state: this.deps.state,
      writer: this.deps.writer,
      fence,
      items,
      receipt,
      boundary: { reason, providerHandle }
    })
  }
}
