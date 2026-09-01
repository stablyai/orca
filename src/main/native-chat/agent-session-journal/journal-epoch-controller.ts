import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalCompactionPolicy } from './journal-compaction'
import { quarantineUnreadableSchema } from './journal-corruption-quarantine'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import {
  assertJournalFence,
  assertJournalWritable,
  type JournalAppendBudget
} from './journal-write-guards'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      identity: AgentSessionJournalIdentity
      journalDir: string
      budget: JournalAppendBudget
      compaction: JournalCompactionPolicy
      now: () => number
      mintEpoch: () => string
      serialize: <T>(run: () => Promise<T>) => Promise<T>
      readOnly: () => boolean
      setReadOnly: (readOnly: boolean) => void
      highestFence: () => number
      cursor: () => AgentJournalCursor
      adopt: (loaded: JournalLoad) => void
    }
  ) {}

  async start(reason: AgentJournalEpochReason, fence: number): Promise<void> {
    this.deps.adopt(
      await publishNewEpoch({
        journalDir: this.deps.journalDir,
        sessionId: this.deps.identity.sessionId,
        providerHandle: this.deps.identity.providerHandle,
        epoch: this.deps.mintEpoch(),
        reason,
        fence,
        now: this.deps.now(),
        maxSessionBytes: this.deps.budget.maxSessionBytes
      })
    )
  }

  async roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    if (reason !== 'schema_unreadable') {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
    } else if (this.deps.readOnly()) {
      await quarantineUnreadableSchema(this.deps.journalDir, {
        sessionId: this.deps.identity.sessionId,
        maxBytes: this.deps.budget.maxSessionBytes
      })
    }
    await this.start(reason, fence)
    this.deps.setReadOnly(false)
    return this.deps.cursor()
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      assertJournalFence(fence, this.deps.highestFence())
      await replaceJournalEpoch({
        journalDir: this.deps.journalDir,
        identity: this.deps.identity,
        reason,
        fence,
        items,
        budget: this.deps.budget.fork(),
        compaction: this.deps.compaction,
        now: this.deps.now,
        mintEpoch: this.deps.mintEpoch,
        onSnapshotPublished: this.deps.adopt
      })
      return this.deps.cursor()
    })
  }
}
