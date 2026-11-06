import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { JournalReducerState } from './journal-reducer'
import { journalControlStateEntries } from './journal-sql-control-export'
import { JournalInputPlaceIndex, type JournalInputPlaceEntry } from './journal-input-place-index'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputReleasedPositions } from './journal-input-released-positions'
import { JournalInputCandidates } from './journal-input-candidates'
import { JournalSubmissionIndex } from './journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import { journalSqlEntryCard, journalSqlEntryFlags } from './journal-sql-place-index'
import { durableQueuePauseMarks } from './journal-outcome-format-1-decode'
import {
  DirectJournalValues,
  type DirectJournalRecord
} from './journal-sql-direct-values.test-fixture'
import type { JournalOutcomeItemProvenance } from './journal-outcome-item-provenance'
import { memoryJournalMap } from './journal-memory-collections'
import { directJournalQueryFacts } from './journal-sql-direct-queries.test-fixture'

const owners: Record<string, string> = {
  'order.observationFacts': 'observations',
  'order.evidenceFacts': 'evidence',
  'order.links.facts': 'links',
  'order.orderFacts': 'order',
  'order.newestTurn.storage': 'newest-turn',
  'order.lineage.facts': 'lineage',
  'order.cards.facts': 'cards'
}
const indexes: Record<string, string> = {
  'order.receiptSequences': 'receipt-sequences',
  'order.accepted': 'accepted-inputs',
  'order.nonRefused': 'non-refused-inputs',
  'order.acceptedByTime': 'accepted-by-time',
  'order.failedRequests': 'failed-requests',
  'order.stoppedOwed': 'stopped-owed',
  'order.unsettled': 'phase:"unsettled"',
  'order.sending': 'phase:"sending"',
  'order.cards.index': 'card-introductions',
  'order.cards.currentCoordinates': 'card-coordinates',
  'order.cards.domains': 'cards',
  'order.cards.released': 'cards',
  'order.cards.positions': 'card-positions',
  'order.cards.candidates': 'cards'
}
const handles: Record<string, string> = {
  'observations.providerInputs': 'provider-inputs',
  'observations.dispatchByFence': 'dispatch-by-fence',
  'observations.signedOutByFence': 'signed-out-members',
  'evidence.keptCards': 'kept-card-members',
  'evidence.steers': 'steers',
  'evidence.coveredBy': 'carrier-coverers',
  'links.linked': 'link-family'
}

/** Only the in-process experiment consumes this generator; no production opener selects it. */
export class DirectJournalControl {
  readonly values: DirectJournalValues
  constructor(
    private readonly state: JournalReducerState,
    provenance: JournalOutcomeItemProvenance
  ) {
    this.values = new DirectJournalValues(state, provenance)
  }

  *records(): Generator<DirectJournalRecord> {
    // Item locations and their bodies exist before any control holder can capture them.
    for (const [key, item] of memoryJournalMap(this.state.items)) {
      yield* this.values.value('items', key, item)
    }
    for (const entry of journalControlStateEntries(this.state)) {
      const path = entry.path.join('.')
      if (path === 'state.items') {
        continue
      }
      const parent = entry.path.slice(0, -1).join('.')
      const field = entry.path.at(-1)!
      if (entry.container) {
        const name = path.startsWith('state.')
          ? path.slice(6)
          : owners[parent]
            ? `${owners[parent]}.${field}`
            : indexes[path]
        if (!name) {
          throw new Error(`Unmapped direct journal container: ${path}`)
        }
        yield* this.container(name, entry.value)
      } else if (path === 'state.queuePauseMarks') {
        yield* this.pauseMarks()
      } else if (path === 'state.derivedTurnScope.openTurnItemId') {
        yield scalar('reducer', 'derivedTurnScope', this.state.derivedTurnScope.snapshot())
      } else if (parent === 'state' && field !== 'sessionId' && field !== 'epoch') {
        yield scalar('reducer', field, entry.value)
      } else if (parent === 'state.queue' || parent === 'state.inputs') {
        yield scalar(parent.slice(6), field, entry.value)
      } else if (owners[parent]) {
        if (
          path === 'order.newestTurn.storage.initializeFromItems' ||
          path === 'order.cards.facts.overlayRows'
        ) {
          continue
        }
        let value = entry.value
        if (path === 'order.cards.facts.pauseKey' && Array.isArray(value)) {
          const marks = this.state.queuePauseMarks
          value = value.map((part) =>
            part && part === marks.latestStop
              ? 'stop:1'
              : part && part === marks.cleared
                ? 'clear:1'
                : part
          )
        }
        yield scalar(owners[parent], field, value)
      } else if (path !== 'state.sessionId' && path !== 'state.epoch') {
        throw new Error(`Unmapped direct journal scalar: ${path}`)
      }
    }
    yield* directJournalQueryFacts(this.state)
    yield* this.values.finish()
  }

  private *container(name: string, value: object): Generator<DirectJournalRecord> {
    if (value instanceof Map || value instanceof Set) {
      for (const [key, child] of value.entries()) {
        const handle = handles[name]
        if (handle) {
          yield* this.values.value(`@handles:${handle}`, key, key)
          yield* this.container(`${handle}:${JSON.stringify(key)}`, child)
        } else {
          yield* this.values.value(name, key, child)
        }
      }
    } else if (value instanceof JournalInputPlaceIndex) {
      for (const entry of value.exportEntries()) {
        yield* this.place(name, entry)
      }
    } else if (value instanceof JournalInputDomainIndex) {
      for (const { introduced, entry } of value.exportEntries()) {
        yield* this.place(name, entry, introduced)
      }
    } else if (value instanceof JournalInputReleasedPositions) {
      const state = value.exportState()
      yield* this.container(`${name}:released-at`, state.domains)
      yield* this.container(`${name}:released-fallback`, state.fallback)
      const paused = state.floor !== -Infinity
      let any = false
      for (const entry of state.releases) {
        any = true
        yield {
          table: 'releases',
          values: [
            name,
            entry.id,
            entry.sequence,
            entry.position,
            Number(paused && state.sincePause.has(entry.id))
          ]
        }
      }
      if (any || paused) {
        yield {
          table: 'release_state',
          values: [name, paused ? state.floor : null, Number(paused)]
        }
      }
    } else if (value instanceof JournalInputCandidates) {
      for (const card of value.exportCards()) {
        const token = yield* this.values.index(`candidates:${name}`, card.messageId, card)
        yield {
          table: 'candidates',
          values: [
            name,
            card.messageId,
            card.position,
            Number(!!orchestrationMailNotice(card.body.from)),
            token
          ]
        }
      }
    } else if (value instanceof JournalSubmissionIndex) {
      for (const [id, entry] of value.exportEntries()) {
        yield* this.values.value(name, id, entry)
      }
    } else if (value instanceof MemoryJournalTurnSources) {
      for (const [id, source] of value.exportSources()) {
        const token = yield* this.values.index('turn-sources', id, source)
        yield {
          table: 'turn_sources',
          values: [
            id,
            source.item.sequence,
            source.item.sequenceIndex ?? 0,
            Number(source.ordinary),
            Number(source.relevant),
            token
          ]
        }
      }
    } else {
      throw new Error(`Unknown direct journal container: ${name}`)
    }
  }

  private *place(
    name: string,
    entry: JournalInputPlaceEntry,
    introduced?: number
  ): Generator<DirectJournalRecord> {
    const kind = introduced === undefined ? 'places' : 'domains'
    const card = journalSqlEntryCard(entry)
    const token = card ? yield* this.values.index(`${kind}:${name}`, entry.id, card) : null
    yield {
      table: kind,
      values: [
        name,
        entry.id,
        ...(introduced === undefined ? [] : [introduced]),
        entry.domain ?? (introduced === undefined ? null : ''),
        entry.sequence,
        ...(introduced === undefined ? [entry.tie ?? 0] : []),
        entry.position,
        ...journalSqlEntryFlags(entry),
        token
      ]
    }
  }

  private *pauseMarks(): Generator<DirectJournalRecord> {
    const marks = this.state.queuePauseMarks
    const clear = marks.cleared
    yield scalar('pause-marks', 'header', {
      ...marks,
      cleared: clear ? { ...clear, messageIds: null } : undefined
    })
    yield {
      table: 'scalars',
      values: ['pause-marks', 'encoded', JSON.stringify(durableQueuePauseMarks(marks))]
    }
    yield scalar('pause-marks', 'stopVersion', 1)
    yield scalar('pause-marks', 'clearVersion', 1)
    for (const [ordinal, id] of (clear?.messageIds ?? []).entries()) {
      yield { table: 'clear_members', values: [ordinal, id] }
    }
  }
}

function scalar(owner: string, name: string, value: unknown): DirectJournalRecord {
  return { table: 'scalars', values: [owner, name, JSON.stringify(value ?? null)] }
}
