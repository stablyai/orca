import type { JournalReadConnection } from './journal-sql-owner'
import {
  firstJournalInputEvidence,
  originalJournalInputItems,
  finishJournalInputRead,
  type JournalInputReadSteps
} from './journal-input-evidence-read'
export {
  finishJournalInputRead,
  finishJournalInputReadAsync,
  type JournalInputReadSteps
} from './journal-input-evidence-read'
import { sortJournalSteps } from './journal-reconstruction-steps'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
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
import type Database from '../../sqlite/sync-database'
export function readHistoricalAdmissionSources(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  state: JournalReducerState
): Map<string, JournalInputSource> {
  return finishJournalInputRead(historicalAdmissionSourceSteps(db, sessionId, epoch, source, state))
}

/** First is evidence only when the item's original admission and its metadata agree. */
export function* historicalAdmissionSourceSteps(
  db: Database.Database | JournalReadConnection,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  state: JournalReducerState,
  decisions?: Map<string, number>
): JournalInputReadSteps<Map<string, JournalInputSource>> {
  const page = firstJournalInputEvidence(db, 'submissions')
  const sources = new Map<string, JournalInputSource>()
  let after = ''
  for (;;) {
    const records = yield page(source.generation, after, source.through)
    if (!records.length) {
      break
    }
    const itemKeys: string[] = []
    for (const record of records) {
      if (typeof record.entry_key !== 'string') {
        throw new JournalOutcomeDecodeError('invalid historical submission key')
      }
      after = record.entry_key
      if (typeof record.decision_seq === 'number') {
        decisions?.set(after, record.decision_seq)
      }
      const id: unknown = JSON.parse(after)
      if (typeof id === 'string' && !state.inputs.sources.has(id)) {
        itemKeys.push(JSON.stringify(agentJournalSubmissionKey(id)))
      }
      yield
    }
    const originals = itemKeys.length
      ? yield originalJournalInputItems(db, source.generation, source.through, itemKeys)
      : []
    const items = new Map(
      originals.filter((row) => row.field === 'items').map((row) => [row.entry_key, row])
    )
    const fences = new Map(
      originals.filter((row) => row.field === 'itemFences').map((row) => [row.entry_key, row])
    )
    for (const record of records) {
      yield
      const knownId: unknown = JSON.parse(record.entry_key as string)
      if (typeof knownId === 'string' && state.inputs.sources.has(knownId)) {
        continue
      }
      if (!record || (record.format !== 1 && record.format !== 2) || record.deleted !== 0) {
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
      const itemRecord = items.get(itemKey)
      const fenceRecord = fences.get(itemKey)
      if (
        !itemRecord ||
        !fenceRecord ||
        (itemRecord.format !== 1 && itemRecord.format !== 2) ||
        (fenceRecord.format !== 1 && fenceRecord.format !== 2) ||
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
  }
  return new Map(
    yield* sortJournalSteps(
      sources,
      ([, a], [, b]) =>
        (a.kind === 'outcome-admission' ? a.sequence : a.seq) -
        (b.kind === 'outcome-admission' ? b.sequence : b.seq)
    )
  )
}
