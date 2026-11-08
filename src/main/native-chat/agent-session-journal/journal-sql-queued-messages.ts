import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { JournalQueuedMessages } from './queued-messages/journal-queued-messages'
import type { DerivedQueuePause } from './queued-messages/queued-message-pause'
import type {
  QueuedMessageHoldReason,
  QueuedMessageRow
} from './queued-messages/queued-message-table'
import type { QueuedMessageUpdate } from './queued-messages/queued-message-update'
import type { JournalTransactionalDatabase } from './database/journal-host-database'
import { JournalSqlReducer } from './journal-sql-reducer'
import type { JournalSqlScope } from './journal-sql-scope'
import { journalMailSenderKey } from './journal-writer-host-facts'
import { JournalRowWriter, type JournalOperationReceipt } from './writing/journal-row-writer'
import {
  queuedMessageEditLeaseHolds,
  type QueuedMessageEditLease
} from './queued-messages/queued-message-edit-leases'
import { SqlQueuedMessageEditLeases } from './journal-sql-edit-leases'

/** Host-memory facts a queue read needs, sent as data like the writer's facts. */
export type JournalSqlQueueFacts = {
  reopenFloor: AgentJournalCursor | null
  editLeases?: readonly QueuedMessageEditLease[]
  mail?: readonly (readonly [string, boolean])[]
}

export type JournalSqlQueueRead = { facts: JournalSqlQueueFacts } & (
  | { kind: 'list' }
  | { kind: 'get'; messageId: string }
  | { kind: 'revision' }
  | { kind: 'cleared-through' }
  | { kind: 'next-input-card'; automatic: boolean; steer: boolean }
  | { kind: 'pauses' }
  | { kind: 'user-stop-in-force' }
  | { kind: 'reopen-mark' }
)

export type JournalSqlQueueReadResult =
  | { kind: 'list'; cards: QueuedMessageRow[] }
  | { kind: 'get'; card: QueuedMessageRow | null }
  | { kind: 'revision'; revision: string }
  | { kind: 'cleared-through'; sequence: number }
  | { kind: 'next-input-card'; card: QueuedMessageRow | null }
  /** The next card is mail from a sender whose availability the host has not answered. */
  | { kind: 'mail-needed'; from: AgentMessageSource }
  | { kind: 'pauses'; pauses: DerivedQueuePause[] }
  | { kind: 'user-stop-in-force'; stop: JournalLatestStop | null }
  /** Whether this handle owes a reopen mark, and where one written now would begin. */
  | { kind: 'reopen-mark'; awaits: boolean; since: number }

class MailNeeded extends Error {
  constructor(readonly from: AgentMessageSource) {
    super('queue read needs mail availability')
  }
}

const refuse = (): never => {
  throw new Error('a journal queue read cannot write')
}

/**
 * The writer's own queue procedures over a reducer shell of the caller's read snapshot. The shell
 * is never flushed and its row writer refuses, so a read can only answer.
 */
export function readJournalSqlQueue(
  read: JournalSqlScope,
  operation: JournalSqlQueueRead
): JournalSqlQueueReadResult {
  // Card selection records the host's reopen floor as a fact; a read keeps it to itself.
  const scope = read.asSnapshot()
  const reducer = new JournalSqlReducer(scope, scope.epoch)
  const { facts } = operation
  const held = queuedMessageEditLeaseHolds(facts.editLeases ?? [])
  const database: JournalTransactionalDatabase = {
    db: scope.db,
    readOnly: true,
    stateDirectory: '',
    transaction: refuse
  }
  const queue = new JournalQueuedMessages({
    sessionId: scope.sessionId,
    serialize: refuse,
    database: () => database,
    readOnly: () => true,
    state: () => reducer.state,
    reopenFloor: () => facts.reopenFloor,
    writer: new JournalRowWriter({
      sessionId: scope.sessionId,
      now: Date.now,
      serialize: refuse,
      database: () => database,
      readOnly: () => true,
      highestFence: () => 0,
      nextSequence: () => 0,
      commit: refuse
    }),
    committed: () => {},
    claimAttachments: refuse,
    editHeld: (messageId) => held(queue.get(messageId))
  })
  queue.mailUnavailable = (card) => {
    const from = card.body.from
    if (!from || !orchestrationMailNotice(from)) {
      return false
    }
    const known = facts.mail?.find(([sender]) => sender === journalMailSenderKey(from))
    if (!known) {
      throw new MailNeeded(from)
    }
    return known[1]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: untracking returns the decoded value the storage proxy wraps, of the same type.
  const plain = <T>(value: T): T => reducer.context.untracked('', value) as T
  const card = (value: QueuedMessageRow | null) => (value ? detachCard(plain(value)) : null)
  switch (operation.kind) {
    case 'list':
      return { kind: 'list', cards: queue.list().map((value) => detachCard(plain(value))) }
    case 'get':
      return { kind: 'get', card: card(queue.get(operation.messageId)) }
    case 'revision':
      return { kind: 'revision', revision: queue.revision() }
    case 'cleared-through':
      return { kind: 'cleared-through', sequence: queue.clearedThrough() }
    case 'next-input-card':
      try {
        return {
          kind: 'next-input-card',
          card: card(queue.nextInputCard(operation.automatic, operation.steer))
        }
      } catch (error) {
        if (error instanceof MailNeeded) {
          return { kind: 'mail-needed', from: error.from }
        }
        throw error
      }
    case 'pauses':
      return {
        kind: 'pauses',
        pauses: queue.pauses().map((pause) => ({
          reason: pause.reason,
          since: pause.since && { ...pause.since },
          ...(pause.messageIds ? { messageIds: [...pause.messageIds] } : {})
        }))
      }
    case 'user-stop-in-force':
      return { kind: 'user-stop-in-force', stop: detachJournalSqlStop(queue.userStopInForce()) }
    case 'reopen-mark':
      return {
        kind: 'reopen-mark',
        awaits: queue.awaitReopenMark(),
        since: reducer.state.lastSequence + 1
      }
  }
}

/** Pause marks are storage proxies; only plain values cross the reader port. */
export function detachJournalSqlStop(stop: JournalLatestStop | null): JournalLatestStop | null {
  return (
    stop && {
      sequence: stop.sequence,
      event: { ...stop.event },
      ...(stop.settle ? { settle: { ...stop.settle } } : {})
    }
  )
}

function detachCard(card: QueuedMessageRow): QueuedMessageRow {
  return JSON.parse(JSON.stringify(card)) as QueuedMessageRow
}

export type JournalSqlQueuePort = {
  read: <K extends JournalSqlQueueRead['kind']>(
    operation: Extract<JournalSqlQueueRead, { kind: K }>
  ) => Promise<JournalSqlQueueReadResult>
  write: (operation: JournalSqlQueueWrite, receipt?: JournalOperationReceipt) => Promise<unknown>
}

export type JournalSqlQueueWrite =
  | {
      kind: 'queue-insert'
      input: {
        messageId: string
        body: AgentJournalMessageItem
        requireAttachments?: true
        holdReason?: QueuedMessageHoldReason
        options?: AgentSessionExecutionOptions
      }
    }
  | { kind: 'queue-update'; input: QueuedMessageUpdate }
  | { kind: 'queue-hold'; messageIds: readonly string[]; reason: QueuedMessageHoldReason }
  | { kind: 'queue-withdraw'; messageIds: readonly string[] }
  | { kind: 'queue-move'; input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor }

/**
 * The one ordered queue of a SQL journal: every read is a named procedure on a reader snapshot and
 * every change is the writer's queue command. Nothing about the cards is retained here.
 */
export class SqlJournalQueuedMessages {
  /** Mail the orchestration owner cannot confirm now; the host installs it once. */
  mailUnavailable: ((from: AgentMessageSource) => boolean) | undefined
  readonly editLeases: SqlQueuedMessageEditLeases

  constructor(
    private readonly port: JournalSqlQueuePort,
    private readonly reopenFloor: () => AgentJournalCursor | null
  ) {
    this.editLeases = new SqlQueuedMessageEditLeases((id) => this.get(id))
  }

  /** The host facts every queue read and write carries. */
  facts(mail?: readonly (readonly [string, boolean])[]): JournalSqlQueueFacts {
    const editLeases = this.editLeases.snapshot()
    return {
      reopenFloor: this.reopenFloor(),
      ...(editLeases.length ? { editLeases } : {}),
      ...(mail?.length ? { mail } : {})
    }
  }

  /** Answer the writer's or a reader's mail question from the host's installed owner. */
  answerMail(from: readonly AgentMessageSource[]): (readonly [string, boolean])[] {
    return from.map((sender) => [
      journalMailSenderKey(sender),
      this.mailUnavailable?.(sender) ?? false
    ])
  }

  async list(): Promise<QueuedMessageRow[]> {
    return (await this.read({ kind: 'list' }, 'list')).cards
  }

  async get(messageId: string): Promise<QueuedMessageRow | null> {
    return (await this.read({ kind: 'get', messageId }, 'get')).card
  }

  async revision(): Promise<string> {
    return (await this.read({ kind: 'revision' }, 'revision')).revision
  }

  async clearedThrough(): Promise<number> {
    return (await this.read({ kind: 'cleared-through' }, 'cleared-through')).sequence
  }

  async nextInputCard(automatic = true, steer = false): Promise<QueuedMessageRow | null> {
    const mail: (readonly [string, boolean])[] = []
    for (;;) {
      const result = await this.port.read({
        kind: 'next-input-card',
        automatic,
        steer,
        facts: this.facts(mail)
      })
      if (result.kind === 'next-input-card') {
        return result.card
      }
      if (result.kind !== 'mail-needed') {
        throw new Error(`journal queue reader answered ${result.kind} for next-input-card`)
      }
      mail.push(...this.answerMail([result.from]))
    }
  }

  async pauses(): Promise<DerivedQueuePause[]> {
    return (await this.read({ kind: 'pauses' }, 'pauses')).pauses
  }

  async userStopInForce(): Promise<JournalLatestStop | null> {
    return (await this.read({ kind: 'user-stop-in-force' }, 'user-stop-in-force')).stop
  }

  insert(
    input: Extract<JournalSqlQueueWrite, { kind: 'queue-insert' }>['input'],
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow> {
    return this.port.write({ kind: 'queue-insert', input }, receipt) as Promise<QueuedMessageRow>
  }

  async update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    const result = (await this.port.write({
      kind: 'queue-update',
      input
    })) as AgentSessionQueuedMessageUpdateResult
    this.editLeases.retire(input.messageId)
    return result
  }

  async hold(input: {
    messageIds: readonly string[]
    reason: QueuedMessageHoldReason
  }): Promise<void> {
    await this.port.write({ kind: 'queue-hold', ...input })
  }

  async withdraw(
    messageIds: readonly string[],
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow[]> {
    if (messageIds.length === 0) {
      return []
    }
    return (await this.port.write(
      { kind: 'queue-withdraw', messageIds },
      receipt
    )) as QueuedMessageRow[]
  }

  move(
    input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor,
    receipt?: JournalOperationReceipt
  ): Promise<AgentSessionQueuedMessageMoveResult> {
    return this.port.write(
      { kind: 'queue-move', input },
      receipt
    ) as Promise<AgentSessionQueuedMessageMoveResult>
  }

  private async read<K extends Exclude<JournalSqlQueueRead['kind'], 'next-input-card'>>(
    operation: Omit<Extract<JournalSqlQueueRead, { kind: K }>, 'facts'>,
    kind: K
  ): Promise<Extract<JournalSqlQueueReadResult, { kind: K }>> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the operation is the named read K with its facts attached.
    const request = { ...operation, facts: this.facts() } as Extract<
      JournalSqlQueueRead,
      { kind: K }
    >
    const result = await this.port.read(request)
    if (result.kind !== kind) {
      throw new Error(`journal queue reader answered ${result.kind} for ${kind}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the discriminant was checked above.
    return result as Extract<JournalSqlQueueReadResult, { kind: K }>
  }
}
