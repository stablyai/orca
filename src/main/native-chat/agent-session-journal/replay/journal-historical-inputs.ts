import { journalInputOrder } from '../input-order/journal-input-order'
import {
  journalLegacySubmissionIsPersonal,
  journalSubmissionIsPersonal
} from '../submissions/journal-submission-fold'
import { outcomeFormat3Card } from '../outcomes/journal-outcome-format-3'
import { z } from 'zod'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { JournalOutcomeSource } from '../outcomes/journal-outcome-format'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'

import { JournalOutcomeDecodeError } from '../writing/journal-write-guards'
import {
  strictJournalInputSource,
  type JournalInputSource,
  type JournalHistoricalAdmissionSource
} from '../input-order/journal-input-source-schema'
import {
  outcomeFormat1Stored,
  outcomeFormat1Fields,
  outcomeFormat1EntryParsers
} from '../outcomes/journal-outcome-format-1'
import type { JournalReducerState } from '../projection/journal-reducer'
import type Database from '../../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
/** First is evidence only when the item's original admission and its metadata agree. */
export function readHistoricalAdmissionSources(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  state: JournalReducerState
): Map<string, JournalInputSource> {
  const first = db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation = ? AND field = ? AND entry_key = ?
    AND seq <= ? ORDER BY seq LIMIT 1`)
  const keys = db.prepare(`SELECT entry_key FROM journal_outcomes
    WHERE generation = ? AND field = 'submissions' AND entry_key > ? AND seq <= ?
    ORDER BY entry_key, seq DESC LIMIT 1`)
  const sources = new Map<string, JournalInputSource>()
  let after = ''
  for (;;) {
    const key = keys.get(source.generation, after, source.through)
    if (!key) {
      break
    }
    if (typeof key.entry_key !== 'string') {
      throw new JournalOutcomeDecodeError('invalid historical submission key')
    }
    after = key.entry_key
    const knownId: unknown = JSON.parse(key.entry_key)
    if (typeof knownId === 'string' && state.inputs.sources.has(knownId)) {
      continue
    }
    const record = first.get(source.generation, 'submissions', key.entry_key, source.through)
    if (
      !record ||
      (record.format !== 1 && record.format !== 2 && record.format !== 3) ||
      record.deleted !== 0
    ) {
      continue
    }
    const value = decodeJournalOutcome(record)
    const [id, submission] = outcomeFormat1EntryParsers.submissions.parse(JSON.parse(value.json))
    const current = state.submissions.get(id)
    if (
      current &&
      (current.payloadFingerprint !== submission.payloadFingerprint ||
        current.submittedSequence !== submission.submittedSequence ||
        current.submittedAt !== submission.submittedAt)
    ) {
      continue
    }
    const itemKey = JSON.stringify(agentJournalSubmissionKey(id))
    const itemRecord = first.get(source.generation, 'items', itemKey, source.through)
    const fenceRecord = first.get(source.generation, 'itemFences', itemKey, source.through)
    if (
      !itemRecord ||
      !fenceRecord ||
      (itemRecord.format !== 1 && itemRecord.format !== 2 && itemRecord.format !== 3) ||
      (fenceRecord.format !== 1 && fenceRecord.format !== 2 && fenceRecord.format !== 3) ||
      itemRecord.deleted !== 0 ||
      fenceRecord.deleted !== 0 ||
      itemRecord.seq !== value.seq ||
      fenceRecord.seq !== value.seq
    ) {
      continue
    }
    const item = outcomeFormat1Fields.items.element.parse(
      JSON.parse(decodeJournalOutcome(itemRecord).json)
    )
    const [, fence] = outcomeFormat1Stored.itemFences.parse(
      JSON.parse(decodeJournalOutcome(fenceRecord).json)
    )
    if (
      item.itemId !== agentJournalSubmissionKey(id) ||
      item.revision !== 0 ||
      item.sequence !== value.seq ||
      item.observedAt !== submission.submittedAt ||
      submission.submittedSequence !== value.seq ||
      submission.dispatchState !== 'pending' ||
      (submission.handoverRecorded === true && submission.acceptedSequence !== value.seq) ||
      submission.resolvedAt !== null ||
      submission.providerItemId !== null ||
      submission.reason !== null ||
      fence !== submission.fence ||
      item.body.kind !== 'message' ||
      agentSessionSendBodyFingerprint(sessionId, item.body) !== submission.payloadFingerprint
    ) {
      continue
    }
    const admission: JournalHistoricalAdmissionSource = {
      kind: 'outcome-admission',
      epoch,
      sequence: value.seq,
      item,
      submission,
      fence
    }
    if (!strictJournalInputSource.safeParse(admission).success) {
      throw new JournalOutcomeDecodeError('invalid historical admission')
    }
    sources.set(id, admission)
  }
  return new Map(
    [...sources].sort(
      ([, a], [, b]) =>
        (a.kind === 'outcome-admission' ? a.sequence : a.seq) -
        (b.kind === 'outcome-admission' ? b.sequence : b.seq)
    )
  )
}

/** Classify only after the final canonical cards and original admissions have been restored. */
export function restoredJournalPersonAcceptance(
  db: Database.Database,
  state: JournalReducerState,
  source?: JournalOutcomeSource,
  legacyCards?: ReadonlyMap<string, QueuedMessageRow>
): (submission: AgentJournalSubmission) => boolean {
  const cards =
    source &&
    db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=? AND field='queue.cards' AND entry_key=?
    AND seq<=? AND deleted=0 ORDER BY seq DESC LIMIT 1`)
  const admissionFormat =
    source &&
    db.prepare(`SELECT format FROM journal_outcomes
    WHERE generation=? AND seq=? AND field='submissions' AND entry_key=? AND deleted=0`)
  return (submission) => {
    let card = submission.queuedMessageId
      ? state.queue.cards.get(submission.queuedMessageId)
      : undefined
    if (!card && submission.queuedMessageId && source && cards) {
      const stored = cards.get(
        source.generation,
        JSON.stringify(submission.queuedMessageId),
        source.through
      )
      if (stored) {
        card = z
          .tuple([z.string(), outcomeFormat3Card])
          .parse(JSON.parse(decodeJournalOutcome(stored).json))[1]
      }
    }
    card ??= submission.queuedMessageId ? legacyCards?.get(submission.queuedMessageId) : undefined
    const queue = { cards: new Map(card ? [[card.messageId, card]] : []) }
    if (card || !submission.queuedMessageId) {
      return journalSubmissionIsPersonal({ queue }, submission)
    }
    if (!journalLegacySubmissionIsPersonal(state, submission)) {
      return false
    }
    const admission = state.inputs.sources.get(submission.clientMessageId)
    if (admission?.kind === 'submission') {
      return admission.seq <= (source?.prefix ?? state.lastSequence)
    }
    if (!admission || !source || admission.sequence > source.through) {
      return false
    }
    const original = admissionFormat?.get(
      source.generation,
      admission.sequence,
      JSON.stringify(submission.clientMessageId)
    )
    return original?.format === 1 || original?.format === 2
  }
}

/** Older retirement outcomes may remove an accepted input's newest key, not its acceptance. */
export function restoreHistoricalPersonAcceptance(
  db: Database.Database,
  state: JournalReducerState,
  source: JournalOutcomeSource
): void {
  const personal = restoredJournalPersonAcceptance(db, state, source)
  const owner = journalInputOrder(state)
  const accepted = db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=? AND seq>? AND seq<=?
    AND field='submissions' AND deleted=0 ORDER BY seq DESC`)
  for (const record of accepted.iterate(
    source.generation,
    owner.latestPersonAcceptedSequence(),
    source.through
  )) {
    if (typeof record.seq !== 'number') {
      throw new JournalOutcomeDecodeError('invalid historical outcome sequence')
    }
    // An admission cannot be newer than its outcome; later acceptance does not change that admission.
    if (record.seq <= owner.latestPersonAcceptedSequence()) {
      break
    }
    if (record.field !== 'submissions' || record.deleted !== 0) {
      continue
    }
    const value = decodeJournalOutcome(record)
    const [, submission] = outcomeFormat1EntryParsers.submissions.parse(JSON.parse(value.json))
    if (
      submission.dispatchState !== 'accepted' ||
      (submission.acceptedSequence ?? 0) <= owner.latestPersonAcceptedSequence()
    ) {
      continue
    }
    if (personal(submission)) {
      owner.seedPersonAcceptance(submission.acceptedSequence ?? 0)
    }
  }
}
