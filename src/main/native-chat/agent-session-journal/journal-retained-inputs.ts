import {
  firstJournalInputEvidence,
  JOURNAL_INPUT_EVIDENCE_PAGE
} from './journal-input-evidence-read'
import { journalInputOrder } from './journal-input-order'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  historicalAdmissionSourceSteps,
  finishJournalInputRead,
  finishJournalInputReadAsync,
  type JournalInputReadSteps
} from './journal-historical-inputs'
import type { JournalReadConnection } from './journal-sql-owner'
import { sortJournalSteps } from './journal-reconstruction-steps'
import { decodeJournalOutcome } from './journal-outcome-codec'
import { outcomeFormat1EntryParsers } from './journal-outcome-format-1'
import type { JournalOutcomeSource } from './journal-outcome-format'
import type { JournalReducerState } from './journal-reducer'
import { refreshJournalInputCandidate } from './journal-input-obligations'
import {
  journalInputSourceFamily,
  journalInputSourceId,
  journalInputSourceSequence
} from './journal-input-source'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from './journal-dispatch-doubt-reasons'
import type Database from '../../sqlite/sync-database'

/** Restore runtime views from retained admissions; newest complete records still own deletion. */
export function restoreRetainedJournalInputs(
  db: Database.Database,
  state: JournalReducerState,
  source: JournalOutcomeSource,
  prefixRevisions?: ReadonlyMap<string, number>
): void {
  finishJournalInputRead(retainedJournalInputSteps(db, state, source, prefixRevisions))
}
export function restoreRetainedJournalInputsAsync(
  read: JournalReadConnection,
  state: JournalReducerState,
  source: JournalOutcomeSource,
  prefixRevisions?: ReadonlyMap<string, number>
): Promise<void> {
  return finishJournalInputReadAsync(
    retainedJournalInputSteps(read, state, source, prefixRevisions)
  )
}

function* retainedJournalInputSteps(
  db: Database.Database | JournalReadConnection,
  state: JournalReducerState,
  source: JournalOutcomeSource,
  prefixRevisions?: ReadonlyMap<string, number>
): JournalInputReadSteps<void> {
  const decisions = new Map<string, number>()
  const admissions = yield* historicalAdmissionSourceSteps(
    db,
    state.sessionId,
    state.epoch,
    source,
    state,
    decisions
  )
  for (const [id, admission] of admissions) {
    yield
    state.inputs.sources.set(id, admission)
  }
  const ordered = yield* sortJournalSteps(
    state.inputs.sources,
    ([, a], [, b]) => (journalInputSourceSequence(a) ?? 0) - (journalInputSourceSequence(b) ?? 0)
  )
  const families = new Map<string, typeof ordered>()
  for (const [id, admission] of ordered) {
    yield
    const family = journalInputSourceFamily(admission)
    if (family) {
      const members = families.get(family) ?? []
      members.push([id, admission])
      families.set(family, members)
    }
    journalInputOrder(state).refreshLink(id)
    const send = state.submissions.get(id)
    if (
      family &&
      send?.dispatchState === 'unknown' &&
      send.recovered &&
      send.reason === DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED
    ) {
      state.inputs.rejections.set(id, send)
    }
  }
  const page = firstJournalInputEvidence(db, 'queue.cards')
  let after = ''
  for (;;) {
    const records = yield page(source.generation, after, source.through)
    if (!records.length) {
      break
    }
    for (const record of records) {
      yield
      if (typeof record.entry_key !== 'string') {
        throw new Error('invalid retained card key')
      }
      after = record.entry_key
      if (!record || record.deleted !== 0) {
        continue
      }
      const value = decodeJournalOutcome(record)
      const [id, card] = outcomeFormat1EntryParsers['queue.cards'].parse(JSON.parse(value.json))
      // A raw-prefix card already has its actual selection; a tail's first update is not its birth.
      if (value.ordinal === 'b') {
        continue
      }
      const members = families.get(id) ?? []
      const preceding: typeof members = []
      for (const member of members) {
        if ((journalInputSourceSequence(member[1]) ?? Infinity) < value.seq) {
          preceding.push(member)
        }
        yield
      }
      const latest = journalInputSourceId(preceding.at(-1)?.[1])
      const send = latest ? state.submissions.get(latest) : undefined
      const decision = latest ? decisions.get(JSON.stringify(latest)) : undefined
      const decisionSequence = decision ?? Infinity
      const terminalBeforeSelection =
        send &&
        (send.dispatchState === 'accepted' || send.dispatchState === 'rejected') &&
        (send.dispatchState === 'accepted'
          ? (state.receipts.get(latest!)?.cursor.sequence ?? decisionSequence) < value.seq
          : decision !== undefined && decision < value.seq)
      const selected =
        card.consumedAs ??
        (card.holdReason === 'delivery_unconfirmed' && !terminalBeforeSelection
          ? latest
          : undefined)
      if (selected) {
        state.inputs.presentations.set(selected, card)
        const current = state.queue.cards.get(id)
        if (current && !card.consumedAs && card.holdReason === 'delivery_unconfirmed') {
          current.recovers = selected
        }
      }
    }
  }
  state.queue.returnedCommands.clear()
  for (const card of state.queue.cards.values()) {
    yield
    if (card.consumedAs && state.normalizedHandOffs.has(card.consumedAs)) {
      state.inputs.presentations.set(card.consumedAs, card)
    }
    if (card.state === 'returned' && card.body.command && card.consumedAs) {
      state.queue.returnedCommands.add(card.messageId)
    }
  }
  const removals = new Map<string, { sequence: number; native: string; restatements: number }>()
  for (const [provider, native] of state.aliases) {
    yield
    const identity = parseAgentJournalItemKey(native)
    const receipt =
      identity?.provider === 'orca' ? state.receipts.get(identity.clientMessageId) : undefined
    if (!receipt || state.itemEchoes.has(provider)) {
      continue
    }
    if (provider !== receipt.providerItemId) {
      state.inputs.echoes.add(native)
      continue
    }
    const admission =
      identity?.provider === 'orca' ? state.inputs.sources.get(identity.clientMessageId) : undefined
    const sequence = journalInputSourceSequence(admission)
    const item = state.items.get(native)
    if (sequence === undefined || !item) {
      continue
    }
    removals.set(JSON.stringify(native), {
      native,
      sequence: Math.max(sequence, source.prefix),
      restatements: 0
    })
  }
  const keys: string[] = []
  for (const key of removals.keys()) {
    keys.push(key)
    yield
    if (keys.length === JOURNAL_INPUT_EVIDENCE_PAGE) {
      yield* countRetainedRemovals(db, source, keys, removals)
      keys.length = 0
    }
  }
  if (keys.length) {
    yield* countRetainedRemovals(db, source, keys, removals)
  }
  for (const { native, restatements } of removals.values()) {
    yield
    const item = state.items.get(native)!
    if (item.revision > (prefixRevisions?.get(native) ?? 0) + 2 * restatements) {
      state.inputs.echoes.add(native)
    }
  }
  for (const [id] of ordered) {
    yield
    refreshJournalInputCandidate(state, id)
  }
}

/** Read removal evidence in native pages instead of one worker request per alias/removal. */
function* countRetainedRemovals(
  db: Database.Database | JournalReadConnection,
  source: JournalOutcomeSource,
  keys: string[],
  removals: Map<string, { sequence: number; native: string; restatements: number }>
): JournalInputReadSteps<void> {
  const page =
    db.prepare(`WITH inputs(input_key,after_seq) AS (VALUES ${keys.map(() => '(?,?)').join(',')})
    SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM inputs JOIN journal_outcomes ON entry_key=input_key
    WHERE generation=? AND field='tombstones' AND seq>after_seq AND seq<=?
    AND (entry_key,seq)>(?,?) ORDER BY entry_key,seq LIMIT 128`)
  const parameters = keys.flatMap((key) => [key, removals.get(key)!.sequence])
  let after = '',
    sequence = 0
  for (;;) {
    const records = yield page.all(
      ...parameters,
      source.generation,
      source.through,
      after,
      sequence
    )
    if (!records.length) {
      return
    }
    for (const record of records) {
      const removal = decodeJournalOutcome(record)
      after = removal.key
      sequence = removal.seq
      const entry = removals.get(after)!
      if (removal.seq > entry.sequence && !removal.deleted) {
        entry.restatements++
      }
      yield
    }
  }
}
