import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalHostDatabase } from './journal-host-database'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import type { JournalQueueRestatement } from './journal-queued-messages'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'
import type { JournalOperationReceipt } from './journal-row-writer'

import type { JournalAttachmentClaim } from './journal-submission-hook'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      isLiveGoal?: (id: string) => boolean
      claimAttachments?: JournalAttachmentClaim
      identity: AgentSessionJournalIdentity
      now: () => number
      mintEpoch: () => string
      serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
      database: () => JournalHostDatabase
      readOnly: () => boolean
      highestFence: () => number
      state: () => JournalReducerState
      queuePauseRestatement: () => JournalQueuePauseRestatement
      queueRestatement: () => JournalQueueRestatement
      cursor: () => AgentJournalCursor
      adopt: (loaded: JournalLoad) => void
    }
  ) {}

  start(reason: AgentJournalEpochReason, fence: number, expectedEpoch: string | null): void {
    publishNewEpoch({
      expectedEpoch,
      database: this.deps.database(),
      identity: this.deps.identity,
      epoch: this.deps.mintEpoch(),
      reason,
      fence,
      now: this.deps.now(),
      queue: this.deps.queueRestatement(),
      onPublished: this.deps.adopt
    })
  }

  /** Serialize rollover with appends and apply the same writable guard as every other journal write. */
  roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      this.start(reason, fence, this.deps.state().epoch)
      return this.deps.cursor()
    })
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[],
    receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
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
        receipt,
        previous: this.deps.state(),
        claimAttachments: this.deps.claimAttachments,
        isLiveGoal: this.deps.isLiveGoal,
        queuePause: this.deps.queuePauseRestatement(),
        queue: this.deps.queueRestatement(),
        now: this.deps.now,
        mintEpoch: this.deps.mintEpoch,
        onPublished: this.deps.adopt
      })
      return this.deps.cursor()
    })
  }
}
