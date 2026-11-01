import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { JournalOutcomeSource } from './journal-outcome-format'
import { decodeJournalOutcome, JournalOutcomeDecodeError } from './journal-outcome-codec'
import {
  strictJournalInputSource,
  type JournalInputSource,
  type JournalHistoricalAdmissionSource
} from './journal-input-source-schema'
import {
  outcomeFormat1Stored,
  outcomeFormat1Fields,
  outcomeFormat1EntryParsers
} from './journal-outcome-format-1'
import type { JournalReducerState } from './journal-reducer'
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
    if (!record || record.format !== 1 || record.deleted !== 0) {
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
      itemRecord.format !== 1 ||
      fenceRecord.format !== 1 ||
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
