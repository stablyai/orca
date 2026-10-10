import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      identity: AgentSessionJournalIdentity
      now: () => number
      mintEpoch: () => string
      serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
      database: () => JournalHostDatabase
      readOnly: () => boolean
      highestFence: () => number
      /** What of the live epoch's Stop and Resume a replacement restates. */
      queuePauseRestatement: () => JournalQueuePauseRestatement
      cursor: () => AgentJournalCursor
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

  /**
   * Every reason takes the same writable guard: a newer Orca's database refuses a roll like any
   * other write, and `schema_unreadable` has no production caller.
   *
   * Serialized like every other write, so the discard cannot land between an
   * admitted append's sequence assignment and its commit.
   */
  roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      this.start(reason, fence)
      return this.deps.cursor()
    })
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      assertJournalFence(fence, this.deps.highestFence())
      replaceJournalEpoch({
        database: this.deps.database(),
        identity: this.deps.identity,
        reason,
        fence,
        items,
        queuePause: this.deps.queuePauseRestatement(),
        now: this.deps.now,
        mintEpoch: this.deps.mintEpoch,
        onPublished: this.deps.adopt
      })
      return this.deps.cursor()
    })
  }
}
