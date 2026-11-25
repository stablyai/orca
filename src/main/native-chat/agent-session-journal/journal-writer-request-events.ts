import type Database from '../../sqlite/sync-database'
import { JournalDomainRequestFailure } from './journal-domain-request-failure'
import type {
  JournalRequestEvent,
  JournalRequestMark,
  JournalRequestOutcome
} from './journal-request-failure'
import type { JournalStopSettleFact } from './journal-writer-host-facts'

type Target = { sessionId: string; epoch: string }
type Pending = {
  target: Target
  kind: JournalRequestMark['kind']
  id: string
  before: JournalRequestMark | null
}
type Capture = {
  events: JournalRequestEvent[]
  pending: Map<string, Pending>
  stopSettle?: JournalStopSettleFact
}
const captures = new WeakMap<Database.Database, Capture>()

export function beginJournalRequestEvents(
  db: Database.Database,
  stopSettle?: JournalStopSettleFact
): () => JournalRequestEvent[] {
  const capture: Capture = { events: [], pending: new Map(), stopSettle }
  captures.set(db, capture)
  return () => {
    if (captures.get(db) !== capture) {
      return []
    }
    captures.delete(db)
    const resolved: JournalRequestEvent[] = []
    let context: JournalRequestEvent[] = []
    const flush = () => {
      const turns = new Map(
        context.flatMap((event) =>
          event.outcomes
            .filter((outcome) => outcome.kind === 'turn')
            .map((outcome) => [outcome.id, outcome] as const)
        )
      )
      resolved.push(
        ...context.map((event) => ({
          ...event,
          outcomes: event.outcomes.map((outcome) =>
            outcome.kind === 'refused-send' && outcome.linkedTurnItemId
              ? (turns.get(outcome.linkedTurnItemId) ?? outcome)
              : outcome
          )
        }))
      )
      context = []
    }
    for (const event of capture.events) {
      if (event.cleared) {
        flush()
      }
      context.push(event)
    }
    flush()
    return resolved
  }
}

/** Source savepoints restore only this command's transient observations. */
export function checkpointJournalRequestEvents(db: Database.Database): () => void {
  const capture = captures.get(db)
  const pending = capture && new Map(capture.pending)
  const length = capture?.events.length ?? 0
  return () => {
    if (capture && pending) {
      capture.pending = pending
      capture.events.length = length
    }
  }
}

export function beforeJournalRequestWrite(
  db: Database.Database,
  target: Target,
  kind: JournalRequestMark['kind'],
  id: string
): void {
  const capture = captures.get(db)
  if (!capture) {
    return
  }
  const key = JSON.stringify([target.epoch, kind, id])
  if (!capture.pending.has(key)) {
    capture.pending.set(key, {
      target,
      kind,
      id,
      before: new JournalDomainRequestFailure(db, target, capture.stopSettle).request(kind, id)
    })
  }
}

export function appendJournalRequestEvent(
  db: Database.Database,
  target: Target,
  sequence: number
): void {
  const capture = captures.get(db)
  if (!capture || capture.pending.size === 0) {
    return
  }
  const view = new JournalDomainRequestFailure(db, target, capture.stopSettle)
  const outcomes: JournalRequestOutcome[] = []
  for (const [key, pending] of capture.pending) {
    if (pending.target.epoch === target.epoch) {
      const before = outcome(pending.before)
      const after = outcome(view.request(pending.kind, pending.id))
      if (after && !(before && before.kind === after.kind && before.id === after.id)) {
        outcomes.push(after)
      }
      capture.pending.delete(key)
    }
  }
  if (outcomes.length || view.floor === sequence) {
    capture.events.push({
      epoch: target.epoch,
      sequence,
      cleared: view.floor === sequence,
      outcomes
    })
  }
}

function outcome(request: JournalRequestMark | null): JournalRequestOutcome | null {
  if (!request || (request.mark !== 'failure' && request.mark !== 'interruption')) {
    return null
  }
  const { mark, linked, ...identity } = request
  const related = linked && outcome(linked)
  if (related?.outcome === 'failure') {
    return related
  }
  return { ...identity, outcome: mark, ...(related ? { linked: related } : {}) }
}
