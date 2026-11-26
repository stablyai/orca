import { memoryJournalMap } from '../journal-memory-collections'
import { journalInputOrder } from '../input-order/journal-input-order'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  readHistoricalAdmissionSources,
  restoredJournalPersonAcceptance
} from './journal-historical-inputs'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { decodeJournalOutcome } from '../outcomes/journal-outcome-codec'
import { outcomeFormat3Card } from '../outcomes/journal-outcome-format-3'
import { z } from 'zod'
import type { JournalOutcomeSource } from '../outcomes/journal-outcome-format'
import type { JournalReducerState } from '../projection/journal-reducer'
import { refreshJournalInputCandidate } from '../input-order/journal-input-obligations'
import {
  journalInputSourceFamily,
  journalInputSourceId,
  journalInputSourceSequence
} from '../input-order/journal-input-source'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from '../projection/journal-dispatch-doubt-reasons'
import type Database from '../../../sqlite/sync-database'

/** Restore runtime views from retained admissions; newest complete records still own deletion. */
export function restoreRetainedJournalInputs(
  db: Database.Database,
  state: JournalReducerState,
  source: JournalOutcomeSource,
  prefixRevisions?: ReadonlyMap<string, number>,
  acceptedPrefix?: ReadonlyMap<string, AgentJournalSubmission>
): void {
  const admissions = readHistoricalAdmissionSources(db, state.sessionId, state.epoch, source, state)
  for (const [id, admission] of admissions) {
    state.inputs.sources.set(id, admission)
  }
  const ordered = [...memoryJournalMap(state.inputs.sources)].sort(
    ([, a], [, b]) => (journalInputSourceSequence(a) ?? 0) - (journalInputSourceSequence(b) ?? 0)
  )
  const families = new Map<string, typeof ordered>()
  const owner = journalInputOrder(state)
  const personal = restoredJournalPersonAcceptance(db, state, source)
  for (const [id, admission] of ordered) {
    const family = journalInputSourceFamily(admission)
    if (family) {
      const members = families.get(family) ?? []
      members.push([id, admission])
      families.set(family, members)
    }
    journalInputOrder(state).refreshLink(id)
    const send = state.submissions.get(id)
    for (const accepted of [send, acceptedPrefix?.get(id)]) {
      if (
        accepted?.dispatchState === 'accepted' &&
        (accepted.acceptedSequence ?? 0) > owner.latestPersonAcceptedSequence() &&
        personal(accepted)
      ) {
        owner.seedPersonAcceptance(accepted.acceptedSequence ?? 0)
      }
    }
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
    const [id, card] = z.tuple([z.string(), outcomeFormat3Card]).parse(JSON.parse(value.json))
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
    const decisionSequence = typeof decision?.seq === 'number' ? decision.seq : Infinity
    const terminalBeforeSelection =
      send &&
      (send.dispatchState === 'accepted' || send.dispatchState === 'rejected') &&
      (send.dispatchState === 'accepted'
        ? (state.receipts.get(latest!)?.cursor.sequence ?? decisionSequence) < value.seq
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
  for (const card of memoryJournalMap(state.queue.cards).values()) {
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
  for (const [provider, native] of memoryJournalMap(state.aliases)) {
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
