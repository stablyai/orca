import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalMailCustody } from './journal-writer-host-facts'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { DerivedQueuePause } from './queued-messages/queued-message-pause'
import type {
  QueuedMessageHoldReason,
  QueuedMessageRow
} from './queued-messages/queued-message-table'
import type { QueuedMessageUpdate } from './queued-messages/queued-message-update'
import type {
  JournalDomainEditLeaseOperation,
  JournalDomainEditLeaseOutcome
} from './journal-domain-edit-leases'
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
import { journalMailSenderKey } from './journal-writer-host-facts'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { SqlQueuedMessageEditLeases } from './journal-sql-edit-leases'
/** Host-memory facts a queue read needs, sent as data like the writer's facts. */
export type JournalSqlQueueFacts = {
  reopenFloor: AgentJournalCursor | null
  mail?: JournalMailCustody
}

export type JournalSqlQueueRead = { facts: JournalSqlQueueFacts } & (
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

export type JournalSqlQueuePort = {
  read: <K extends JournalSqlQueueRead['kind']>(
    operation: Extract<JournalSqlQueueRead, { kind: K }>
  ) => Promise<JournalSqlQueueReadResult>
  write: (operation: JournalSqlQueueWrite, receipt?: JournalOperationReceipt) => Promise<unknown>
  edit: (operation: JournalDomainEditLeaseOperation) => Promise<JournalDomainEditLeaseOutcome>
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
        deliveryMode?: 'queue' | 'steer'
        unattended?: boolean
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
  /** Read-only custody for each sender; the host installs its orchestration owner once. */
  mailOwed: ((source: AgentMessageSource) => QueuedMessageOwed) | undefined
  readonly editLeases: SqlQueuedMessageEditLeases
  private revisionKey: string

  constructor(
    private readonly port: JournalSqlQueuePort,
    private readonly reopenFloor: () => AgentJournalCursor | null,
    private readonly now: () => number,
    revision: string
  ) {
    this.revisionKey = revision
    this.editLeases = new SqlQueuedMessageEditLeases(port.edit, now)
  }

  /** The host facts every queue read and write carries. */
  facts(mail?: JournalMailCustody): JournalSqlQueueFacts {
    return {
      reopenFloor: this.reopenFloor(),
      ...(mail?.length ? { mail } : {})
    }
  }

  answerMail(cards: readonly QueuedMessageRow[]): JournalMailCustody {
    const mail = new Map<string, QueuedMessageOwed>()
    for (const card of cards) {
      const source = card.body.from
      if (card.state !== 'waiting' || !source || !orchestrationMailNotice(source)) {
        continue
      }
      const sender = journalMailSenderKey(source)
      if (!mail.has(sender)) {
        mail.set(sender, this.mailOwed?.(source) ?? 'owed')
      }
    }
    return [...mail]
  }

  async failureHolds(): Promise<boolean> {
    return (await this.read({ kind: 'failure-holds' }, 'failure-holds')).held
  }

  async list(): Promise<QueuedMessageRow[]> {
    return (await this.read({ kind: 'list' }, 'list')).cards
  }

  async get(messageId: string): Promise<QueuedMessageRow | null> {
    return (await this.read({ kind: 'get', messageId }, 'get')).card
  }

  revision = (): string => this.revisionKey
  adoptRevision = (revision: string): void => {
    this.revisionKey = revision
  }

  async clearedThrough(): Promise<number> {
    return (await this.read({ kind: 'cleared-through' }, 'cleared-through')).sequence
  }

  async nextInputCard(
    automatic = true,
    steer = false,
    cards?: readonly QueuedMessageRow[]
  ): Promise<QueuedMessageRow | null> {
    const mail = this.answerMail(cards ?? (await this.list()))
    const result = await this.port.read({
      kind: 'next-input-card',
      automatic,
      steer,
      now: this.now(),
      facts: this.facts(mail)
    })
    if (result.kind !== 'next-input-card') {
      throw new Error(`journal queue reader answered ${result.kind} for next-input-card`)
    }
    return result.card
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: queue-insert returns the card from its writer command.
    return this.port.write({ kind: 'queue-insert', input }, receipt) as Promise<QueuedMessageRow>
  }

  async update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: queue-update returns its wire update result from the writer command.
    const result = (await this.port.write({
      kind: 'queue-update',
      input
    })) as AgentSessionQueuedMessageUpdateResult
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: queue-withdraw returns the cards its writer command withdrew.
    return (await this.port.write(
      { kind: 'queue-withdraw', messageIds },
      receipt
    )) as QueuedMessageRow[]
  }

  move(
    input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor,
    receipt?: JournalOperationReceipt
  ): Promise<AgentSessionQueuedMessageMoveResult> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: queue-move returns its wire move result from the writer command.
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
