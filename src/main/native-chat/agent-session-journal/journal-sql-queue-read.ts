import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import {
  selectJournalEligibleQueueCard,
  journalDomainResolvedInputEligibility
} from './journal-domain-input-eligibility'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlWork, readJournalSqlWorkInput } from './journal-sql-work-read'
import { sameJournalCursor } from './replay/journal-cursor'
import { copyJournalCurrentWorkAuthority } from './journal-observer-read'
import type { JournalSqlWorkResult, JournalWorkRead } from './journal-work-read'
import type { JournalMailCustody } from './journal-writer-host-facts'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { DerivedQueuePause } from './queued-messages/queued-message-pause'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import {
  journalDomainQueueAwaitsReopen,
  readJournalDomainQueueHead,
  readJournalDomainQueueList,
  readJournalDomainQueuePauses,
  readJournalDomainUserStopInForce
} from './journal-domain-queue-reads'
import { nextJournalDomainQueueCard } from './journal-domain-submission-consume'
import type { JournalSqlScope } from './journal-sql-scope'

/** Host-memory facts a queue read needs, sent as data like the writer's facts. */
export type JournalSqlQueueFacts = {
  reopenFloor: AgentJournalCursor | null
  mail?: JournalMailCustody
}

export type JournalSqlQueueRead = { facts: JournalSqlQueueFacts } & (
  | {
      kind: 'eligible-input-card'
      authority: JournalCurrentWorkAuthority
      allowSteer: boolean
      now: number
      resolved?: JournalSqlWorkResult
    }
  | { kind: 'list' }
  | { kind: 'get'; messageId: string }
  | { kind: 'revision' }
  | { kind: 'cleared-through' }
  | { kind: 'next-input-card'; automatic: boolean; steer: boolean; now: number }
  | { kind: 'failure-holds' }
  | { kind: 'pauses' }
  | { kind: 'user-stop-in-force' }
  | { kind: 'reopen-mark' }
)

export type JournalSqlQueueReadResult =
  | { kind: 'eligible-input-card'; card: QueuedMessageRow | null; work?: JournalSqlWorkResult }
  | { kind: 'list'; cards: QueuedMessageRow[] }
  | { kind: 'get'; card: QueuedMessageRow | null }
  | { kind: 'revision'; revision: string }
  | { kind: 'cleared-through'; sequence: number }
  | { kind: 'next-input-card'; card: QueuedMessageRow | null }
  | { kind: 'failure-holds'; held: boolean }
  | { kind: 'pauses'; pauses: DerivedQueuePause[] }
  | { kind: 'user-stop-in-force'; stop: JournalLatestStop | null }
  /** Whether this handle owes a reopen mark, and where one written now would begin. */
  | { kind: 'reopen-mark'; awaits: boolean; since: number }

/** Named queue reads on the current cards, typed head facts and persisted edit holds of one snapshot. */
export function readJournalSqlQueue(
  read: JournalSqlScope,
  operation: JournalSqlQueueRead
): JournalSqlQueueReadResult {
  const { db } = read
  const target = { sessionId: read.sessionId, epoch: read.epoch }
  const { facts } = operation
  switch (operation.kind) {
    case 'eligible-input-card': {
      if (operation.resolved) {
        const context = new JournalSqlStatusContext(read, 'input')
        const prior = operation.resolved
        const cursor = { epoch: context.epoch, sequence: context.sequence }
        const physicalCursor = { epoch: read.epoch, sequence: context.sequence }
        const input: Extract<JournalWorkRead, { kind: 'input' }> = {
          kind: 'input',
          now: operation.now,
          facts,
          allowSteer: operation.allowSteer
        }
        const state = prior.result.kind === 'state' ? prior.result.state : undefined
        const reusable =
          state &&
          sameJournalCursor(prior.cursor, cursor) &&
          sameJournalCursor(prior.physicalCursor, physicalCursor) &&
          JSON.stringify(copyJournalCurrentWorkAuthority(prior.authority)) ===
            JSON.stringify(operation.authority)
        const work =
          reusable && state
            ? {
                cursor,
                physicalCursor,
                authority: operation.authority,
                result: readJournalSqlWorkInput(context, operation.authority, input, state, () =>
                  journalDomainResolvedInputEligibility(context, state)
                )
              }
            : readJournalSqlWork(context, { authority: operation.authority, operation: input })
        if (work.result.kind !== 'input') {
          throw new Error('journal queue work answer changed kind')
        }
        return {
          kind: operation.kind,
          card: 'card' in work.result.queue ? work.result.queue.card : null,
          work
        }
      }
      const selected = selectJournalEligibleQueueCard(
        read,
        operation.authority,
        operation.now,
        facts,
        operation.allowSteer
      )
      return { kind: operation.kind, card: selected.kind === 'selected' ? selected.card : null }
    }
    case 'list':
      return { kind: 'list', cards: readJournalDomainQueueList(db, target) }
    case 'get':
      return {
        kind: 'get',
        card: journalDomainQueueRow(db, target, operation.messageId)?.card ?? null
      }
    case 'revision': {
      const { queueRevision } = readJournalDomainQueueHead(db, target)
      return { kind: 'revision', revision: `${target.epoch}:${queueRevision}` }
    }
    case 'cleared-through':
      return {
        kind: 'cleared-through',
        sequence: readJournalDomainQueueHead(db, target).clearedThrough
      }
    case 'next-input-card': {
      const selected = nextJournalDomainQueueCard(db, target, {
        reopenFloor: facts.reopenFloor,
        now: operation.now,
        steer: operation.steer,
        automatic: operation.automatic,
        mail: facts.mail
      })
      return { kind: 'next-input-card', card: selected.kind === 'selected' ? selected.card : null }
    }
    case 'failure-holds':
      return {
        kind: 'failure-holds',
        held: readJournalDomainQueuePauseContext(db, target, facts.reopenFloor, []).pauses.some(
          (pause) => pause.reason === 'failed'
        )
      }
    case 'pauses':
      return {
        kind: 'pauses',
        pauses: readJournalDomainQueuePauses(db, target, facts.reopenFloor)
      }
    case 'user-stop-in-force':
      return { kind: 'user-stop-in-force', stop: readJournalDomainUserStopInForce(db, target) }
    case 'reopen-mark':
      return {
        kind: 'reopen-mark',
        awaits: journalDomainQueueAwaitsReopen(db, target),
        since: readJournalDomainQueueHead(db, target).lastSequence + 1
      }
  }
}
