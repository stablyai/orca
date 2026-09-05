import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      identity: AgentSessionJournalIdentity
      now: () => number
      mintEpoch: () => string
      serialize: <T>(run: () => Promise<T>) => Promise<T>
      database: () => { db: Database.Database }
      readOnly: () => boolean
      setReadOnly: (readOnly: boolean) => void
      highestFence: () => number
      cursor: () => AgentJournalCursor
      adopt: (loaded: JournalLoad) => void
    }
  ) {}

  start(reason: AgentJournalEpochReason, fence: number): void {
    publishNewEpoch({
      db: this.deps.database().db,
      sessionId: this.deps.identity.sessionId,
      providerHandle: this.deps.identity.providerHandle,
      epoch: this.deps.mintEpoch(),
      reason,
      fence,
      now: this.deps.now(),
      onPublished: this.deps.adopt
    })
  }

  /**
   * Every reason takes the same writable guard. A latched store refuses a roll
   * like any other write, and `schema_unreadable` has no production caller.
   *
   * Serialized like every other write, so the discard cannot land between an
   * admitted append's sequence assignment and its commit.
   */
  roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      this.start(reason, fence)
      this.deps.setReadOnly(false)
      return this.deps.cursor()
    })
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      assertJournalFence(fence, this.deps.highestFence())
      replaceJournalEpoch({
        db: this.deps.database().db,
        identity: this.deps.identity,
        reason,
        fence,
        items,
        now: this.deps.now,
        mintEpoch: this.deps.mintEpoch,
        onPublished: this.deps.adopt
      })
      return this.deps.cursor()
    })
  }
}
