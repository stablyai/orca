import type Database from '../../sqlite/sync-database'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readHistoricalAdmissionSources } from './journal-historical-inputs'
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

/** Restore runtime views from retained admissions; newest complete records still own deletion. */
export function restoreRetainedJournalInputs(
  db: Database.Database,
  state: JournalReducerState,
  source: JournalOutcomeSource,
  prefixRevisions?: ReadonlyMap<string, number>
): void {
  const admissions = readHistoricalAdmissionSources(db, state.sessionId, state.epoch, source, state)
  for (const [id, admission] of admissions) {
    state.inputs.sources.set(id, admission)
  }
  const ordered = [...state.inputs.sources].sort(
    ([, a], [, b]) => (journalInputSourceSequence(a) ?? 0) - (journalInputSourceSequence(b) ?? 0)
  )
  const families = new Map<string, typeof ordered>()
  for (const [id, admission] of ordered) {
    const family = journalInputSourceFamily(admission)
    if (family) {
      state.inputs.families.set(family, admission)
      const members = families.get(family) ?? []
      members.push([id, admission])
      families.set(family, members)
    }
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
  const first =
    db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted FROM journal_outcomes
    WHERE generation=? AND field='queue.cards' AND entry_key=? AND seq<=? ORDER BY seq LIMIT 1`)
  const latestSubmission = db.prepare(
    `SELECT seq FROM journal_outcomes WHERE generation=? AND field='submissions' AND entry_key=? AND seq<=? ORDER BY seq DESC LIMIT 1`
  )
  const keys = db.prepare(
    `SELECT entry_key FROM journal_outcomes WHERE generation=? AND field='queue.cards' AND entry_key>? AND seq<=? ORDER BY entry_key,seq DESC LIMIT 1`
  )
  let after = ''
  for (;;) {
    const key = keys.get(source.generation, after, source.through)
    if (!key || typeof key.entry_key !== 'string') {
      break
    }
    after = key.entry_key
    const record = first.get(source.generation, after, source.through)
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
    const preceding = members.filter(
      ([, admission]) => (journalInputSourceSequence(admission) ?? Infinity) < value.seq
    )
    const latest = journalInputSourceId(preceding.at(-1)?.[1])
    const send = latest ? state.submissions.get(latest) : undefined
    const decision = latest
      ? latestSubmission.get(source.generation, JSON.stringify(latest), source.through)
      : undefined
    const terminalBeforeSelection =
      send &&
      (send.dispatchState === 'accepted' || send.dispatchState === 'rejected') &&
      (send.dispatchState === 'accepted'
        ? (state.receipts.get(latest!)?.cursor.sequence ?? decision?.seq ?? Infinity) < value.seq
        : typeof decision?.seq === 'number' && decision.seq < value.seq)
    const selected =
      card.consumedAs ??
      (card.holdReason === 'delivery_unconfirmed' && !terminalBeforeSelection ? latest : undefined)
    if (selected) {
      state.inputs.presentations.set(selected, card)
      const current = state.queue.cards.get(id)
      if (current && !card.consumedAs && card.holdReason === 'delivery_unconfirmed') {
        current.recovers = selected
      }
    }
  }
  state.queue.returnedCommands.clear()
  for (const card of state.queue.cards.values()) {
    if (card.consumedAs && state.normalizedHandOffs.has(card.consumedAs)) {
      state.inputs.presentations.set(card.consumedAs, card)
    }
    if (card.state === 'returned' && card.body.command && card.consumedAs) {
      state.queue.returnedCommands.add(card.messageId)
    }
  }
  const removals =
    db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted FROM journal_outcomes
    WHERE generation=? AND field='tombstones' AND entry_key=? AND seq>? AND seq<=? ORDER BY seq`)
  for (const [provider, native] of state.aliases) {
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
    // Each retained removal plus native restatement advances twice without provider participation.
    let restatements = 0
    for (const record of removals.iterate(
      source.generation,
      JSON.stringify(native),
      Math.max(sequence, source.prefix),
      source.through
    )) {
      const removal = decodeJournalOutcome(record)
      if (!removal.deleted) {
        restatements++
      }
    }
    if (item.revision > (prefixRevisions?.get(native) ?? 0) + 2 * restatements) {
      state.inputs.echoes.add(native)
    }
  }
  for (const [id] of ordered) {
    refreshJournalInputCandidate(state, id)
  }
}
