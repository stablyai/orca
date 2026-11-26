import { z } from 'zod'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  captureHistoryCatchUpView,
  type HistoryCatchUpJournalView
} from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'

/** Pi entries through entry are accounted for through this journal epoch/sequence; encoded in the Pi resume cursor. */
export type PiHistoryClaim = { entry: string; epoch: string; sequence: number }

const claimSchema = z.object({
  entry: z.string().min(1),
  epoch: z.string().min(1),
  sequence: z.number().int().nonnegative()
})

export function encodePiHistoryClaim(claim: PiHistoryClaim): string {
  return JSON.stringify(claim)
}

/** Unknown or unreadable cursors provide no history claim. */
export function decodePiHistoryClaim(value: string | undefined): PiHistoryClaim | null {
  if (value === undefined) {
    return null
  }
  try {
    const parsed = claimSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export type PiHistoryJournalView = {
  epoch: string
  sequence: number
  physicalCursor?: AgentJournalCursor
  hasRows: boolean
  /** Include entries from every file in the conversation lineage. */
  accounted: ReadonlySet<string>
  /** Newest chat turn or accepted prompt, including prompts whose turn row never landed. */
  ownWorkSequence: number
}

export async function readPiHistoryJournalView(
  journal: StructuredAgentSessionHistoryJournal,
  lineage: ReadonlySet<string>
): Promise<PiHistoryJournalView & HistoryCatchUpJournalView> {
  return captureHistoryCatchUpView(journal, async () => {
    const [cursor, hasRows, accepted] = await Promise.all([
      journal.reads.cursor(),
      journal.reads.hasItems(),
      journal.reads.input({ kind: 'accepted-submissions' })
    ])
    const queued = new Set(
      accepted.submissions
        .filter(isQueuedAgentJournalSubmission)
        .map((send) => agentJournalSubmissionKey(send.clientMessageId))
    )
    const accounted = new Set<string>()
    // A prompt accepted before its turn row landed still counts from its acceptance.
    let ownWorkSequence = accepted.latestReceiptSequence
    await journal.reads.visitItems(
      { kinds: ['message', 'tool-call', 'diff', 'approval', 'question', 'status', 'turn'] },
      (itemId, sequence, body) => {
        const identity = parseAgentJournalItemKey(itemId)
        if (
          identity?.provider === 'legacy' &&
          identity.agent === 'pi' &&
          lineage.has(identity.sessionId)
        ) {
          accounted.add(identity.recordId)
          return
        }
        if (
          body.kind === 'turn' ||
          (identity?.provider === 'orca' && body.kind === 'message' && !queued.has(itemId))
        ) {
          ownWorkSequence = Math.max(ownWorkSequence, sequence)
        }
      }
    )
    return { epoch: cursor.epoch, sequence: cursor.sequence, hasRows, accounted, ownWorkSequence }
  })
}

/** Usable only in the journal it describes, and never past what that journal holds. */
export function usablePiHistoryClaim(
  claim: PiHistoryClaim | null,
  view: PiHistoryJournalView
): PiHistoryClaim | null {
  return claim && claim.epoch === view.epoch && claim.sequence <= view.sequence ? claim : null
}

export function samePiHistoryJournalView(
  a: PiHistoryJournalView,
  b: PiHistoryJournalView
): boolean {
  return (
    a.epoch === b.epoch &&
    a.physicalCursor?.epoch === b.physicalCursor?.epoch &&
    a.physicalCursor?.sequence === b.physicalCursor?.sequence &&
    a.hasRows === b.hasRows &&
    a.ownWorkSequence === b.ownWorkSequence &&
    a.accounted.size === b.accounted.size &&
    [...a.accounted].every((id) => b.accounted.has(id))
  )
}
