import { z } from 'zod'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionHistoryJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

/**
 * Pi's entries up to `entry` are accounted for (shown, or deliberately skipped) by the chat's journal
 * up to `sequence` of `epoch`. Saved as the Pi handle's resume cursor, which only Pi's adapter reads.
 */
export type PiHistoryClaim = { entry: string; epoch: string; sequence: number }

const claimSchema = z.object({
  entry: z.string().min(1),
  epoch: z.string().min(1),
  sequence: z.number().int().nonnegative()
})

export function encodePiHistoryClaim(claim: PiHistoryClaim): string {
  return JSON.stringify(claim)
}

/** A cursor an older build left, or one this build can't read, is no claim at all. */
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
  hasRows: boolean
  /** Pi entries the journal already holds as rows, from any file of this conversation. */
  accounted: ReadonlySet<string>
  /** Where the chat's own newest work was created: a turn its Pi ran, or a prompt handed to it. */
  ownWorkSequence: number
}

export function readPiHistoryJournalView(
  journal: StructuredAgentSessionHistoryJournal,
  lineage: ReadonlySet<string>
): PiHistoryJournalView {
  const accounted = new Set<string>()
  const submissions = journal.submissions()
  const queued = new Set(
    submissions
      .filter(isQueuedAgentJournalSubmission)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  let hasRows = false
  let ownWorkSequence = 0
  journal.visitItems((itemId, sequence, body) => {
    hasRows = true
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
  })
  // A prompt Pi accepted before its turn row landed still counts from its acceptance.
  for (const submission of submissions) {
    const receipt = journal.receiptFor(submission.clientMessageId)
    if (receipt?.cursor.epoch === journal.epoch) {
      ownWorkSequence = Math.max(ownWorkSequence, receipt.cursor.sequence)
    }
  }
  const cursor = journal.cursor()
  return { epoch: cursor.epoch, sequence: cursor.sequence, hasRows, accounted, ownWorkSequence }
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
    a.hasRows === b.hasRows &&
    a.ownWorkSequence === b.ownWorkSequence &&
    a.accounted.size === b.accounted.size &&
    [...a.accounted].every((id) => b.accounted.has(id))
  )
}
