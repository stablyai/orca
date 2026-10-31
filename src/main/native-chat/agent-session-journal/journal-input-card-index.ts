import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalInputPlace } from './journal-input-order'
import {
  queuePauseHolding,
  journalQueueStopHolds,
  type DerivedQueuePause
} from './queued-message-pause'
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery
} from './journal-input-place-index'
import {
  type JournalInputLineageOwner,
  type JournalCardAlias,
  queryInputContext
} from './journal-input-lineage'
import { JournalInputDomainIndex } from './journal-input-domain-index'

export class JournalInputCardIndex {
  private index: JournalInputPlaceIndex | undefined
  private currentCoordinates: JournalInputPlaceIndex | undefined
  private domains: JournalInputDomainIndex | undefined
  private readonly indexed = new Map<
    string,
    {
      card: QueuedMessageRow
      aliases: JournalCardAlias[]
      actionable: boolean
      handoff: boolean
    }
  >()
  private pauseKey: readonly unknown[] = []
  private pauses: readonly DerivedQueuePause[] = []
  private cleared = new Set<string>()
  constructor(private readonly lineage: JournalInputLineageOwner) {}
  command(): QueuedMessageRow | undefined {
    return this.currentCoordinates?.allPlaces().command
  }
  releaseHistory(): void {
    this.domains = undefined
    for (const record of this.indexed.values()) {
      record.aliases = this.lineage.cards.get(record.card.messageId)?.aliases ?? []
    }
  }
  queryCurrent(place: JournalInputPlace): InputPlaceQuery {
    return queryInputContext(
      place.context,
      place.original,
      (coordinate) => this.currentCoordinates!.query(coordinate.epoch, coordinate.sequence),
      () => this.currentCoordinates!.allPlaces(),
      mergeInputPlaces
    )
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    if (place.context.basis === 'observed') {
      return this.index!.query('introduction', place.context.cut)
    }
    if (!this.domains) {
      this.domains = new JournalInputDomainIndex()
      for (const record of this.indexed.values()) {
        record.aliases = record.aliases.map((alias) => ({ ...alias }))
        const { card, aliases, actionable, handoff } = record
        for (const alias of aliases) {
          this.domains.set(card, alias, actionable, handoff)
        }
      }
    }
    return this.domains.query(place.context, place.original)
  }

  ensure(state: JournalReducerState): void {
    const marks = state.queuePauseMarks
    const lifted = Math.max(state.latestAcceptedTurnSequence, marks.resumedSequence)
    const key = [
      journalQueueStopHolds(marks, state.latestAcceptedTurnSequence) ? marks.latestStop : null,
      marks.reopenedSequence > lifted ? marks.reopenedSequence : 0,
      marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted
        ? marks.cleared
        : null
    ]
    if (!this.index || key.some((value, i) => value !== this.pauseKey[i])) {
      this.pauseKey = key
      this.cleared = new Set(key[2] ? marks.cleared?.messageIds : [])
      this.index = new JournalInputPlaceIndex('introduction')
      this.currentCoordinates = new JournalInputPlaceIndex(state.epoch)
      this.domains = undefined
      this.indexed.clear()
      this.pauses = [
        ...(key[0] && marks.latestStop
          ? [
              {
                reason: 'stopped' as const,
                since: { epoch: state.epoch, sequence: marks.latestStop.sequence }
              }
            ]
          : []),
        ...(key[1]
          ? [
              {
                reason: 'restarted' as const,
                since: { epoch: state.epoch, sequence: marks.reopenedSequence }
              }
            ]
          : [])
      ]
      for (const card of state.queue.cards.values()) {
        this.indexCard(state, card)
      }
    }
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.ensure(state)
    const sameCoordinate =
      prior?.queuedAt?.epoch === card.queuedAt?.epoch &&
      prior?.queuedAt?.sequence === card.queuedAt?.sequence
    if (
      prior &&
      prior.position === card.position &&
      prior.state === card.state &&
      prior.holdReason === card.holdReason &&
      prior.consumedAs === card.consumedAs &&
      sameCoordinate &&
      Boolean(prior.body.command) === Boolean(card.body.command)
    ) {
      return
    }
    this.removeDomain(card.messageId)
    this.lineage.change(
      card.messageId,
      card.queuedAt,
      card.state !== 'withdrawn',
      state.lastSequence
    )
    this.indexCard(state, card)
  }

  private removeDomain(id: string): void {
    const prior = this.indexed.get(id)
    if (prior && this.domains) {
      for (const alias of prior.aliases) {
        this.domains.set(prior.card, alias, prior.actionable, prior.handoff, true)
      }
    }
  }

  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    this.removeDomain(card.messageId)
    const attempt = card.consumedAs ? state.submissions.get(card.consumedAs) : undefined
    const cleared = this.cleared.has(card.messageId)
    const actionable =
      !cleared &&
      card.state === 'waiting' &&
      card.holdReason === null &&
      !queuePauseHolding(this.pauses, card)
    const handoff = attempt !== undefined && isQueuedAgentJournalSubmission(attempt)
    const lineage = this.lineage.cards.get(card.messageId)
    const aliases = this.domains
      ? (lineage?.aliases.map((alias) => ({ ...alias })) ?? [])
      : (lineage?.aliases ?? [])
    this.currentCoordinates!.set(card, actionable, handoff)
    this.index!.set(card, actionable, handoff, {
      epoch: 'introduction',
      sequence: lineage?.introduced ?? this.lineage.at(state.lastSequence)
    })
    if (card.state === 'withdrawn') {
      this.indexed.delete(card.messageId)
      return
    }
    this.indexed.set(card.messageId, { card, aliases, actionable, handoff })
    if (this.domains) {
      for (const alias of aliases) {
        this.domains.set(card, alias, actionable, handoff)
      }
    }
  }

  relation(card: QueuedMessageRow, place: JournalInputPlace): boolean {
    const lineage = this.lineage.cards.get(card.messageId)
    if (!lineage || lineage.introduced >= place.context.cut) {
      return false
    }
    if (place.context.basis === 'observed') {
      return true
    }
    const aliases = lineage.aliases
    let low = 0,
      high = aliases.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (aliases[mid].from <= place.context.cut) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    const alias = aliases[low - 1]
    if (
      !alias ||
      (alias.until !== undefined && alias.until <= place.context.cut) ||
      !alias.present
    ) {
      return false
    }
    const coordinate = alias.coordinate
    return queryInputContext(
      place.context,
      place.original,
      (boundary) => coordinate?.epoch === boundary.epoch && coordinate.sequence < boundary.sequence,
      () => true,
      (a, b) => a || b
    )
  }
}
