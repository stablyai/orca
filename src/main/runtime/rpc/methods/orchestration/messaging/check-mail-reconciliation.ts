import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { MailTaker } from '../../../../orchestration/db/messages/mail-taker'
import type { StructuredMailSendRow } from '../../../../orchestration/db/messages/structured-mail-send-store'
import type {
  MailboxDeliveryBatch,
  MailboxDeliveryParams
} from '../../../../orchestration/db/messages/role-mailbox-delivery'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import { settleStructuredMailAttempt } from '../../../../orchestration/mailbox/structured-mail/structured-mail-custody'
import { createStructuredMailboxPointerHost } from '../../../../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host'
import { reconcileLifecycleMessage } from '../../../../orchestration/workers/lifecycle/lifecycle-reconciliation'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredMailSourceHold } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-mail-sources'
import type { JournalMailObservation } from '../../../../../native-chat/agent-session-journal/journal-mail-observation'
import type { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'
import { ORCHESTRATION_MAIL_RECONCILIATION_TIMEOUT_MS } from '../../../../../../shared/orchestration/orchestration-timing-budgets'

const UNKNOWN_MAIL: JournalMailObservation = {
  epoch: '',
  state: { kind: 'unreadable' },
  body: null,
  withdrawal: 'unknown'
}
class ChangedMailReservation extends Error {}

function reservationSet(rows: readonly StructuredMailSendRow[]): string {
  return JSON.stringify(
    rows
      .map((row) => [row.mailbox_handle, row.message_id, row.session_id, row.operation_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  )
}

function currentUnreadMatch(db: OrchestrationDb, original: MessageRow): MessageRow | undefined {
  const current = db.getMessageById(original.id)
  return current &&
    !current.read &&
    current.to_handle === original.to_handle &&
    current.run_id === original.run_id
    ? current
    : undefined
}

export type CheckMailTargetVerification = (
  messages: readonly MessageRow[]
) => Promise<{ reverifySync: () => { allowedIds: ReadonlySet<string>; onHeld: () => void } }>

/** One consuming invocation, including its later wake, owns one reconciliation allowance. */
export class CheckMailReconciliation {
  private readonly deadline = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly host = createStructuredMailboxPointerHost()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly db: OrchestrationDb,
    /** Who this check hands the questions it reads to. */
    readonly taker: MailTaker,
    private readonly signal?: AbortSignal
  ) {}

  dispose(): void {
    clearTimeout(this.timer)
    this.deadline.abort()
  }

  private assertCurrent(revalidate: () => void): void {
    if (this.signal?.aborted) {
      throw new Error('request_aborted')
    }
    revalidate()
  }

  private async within<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.timer) {
      this.timer = setTimeout(
        () => this.deadline.abort(),
        ORCHESTRATION_MAIL_RECONCILIATION_TIMEOUT_MS
      )
      this.timer.unref?.()
    }
    const signal = AbortSignal.any([this.deadline.signal, ...(this.signal ? [this.signal] : [])])
    if (signal.aborted) {
      return undefined
    }
    let aborted: (() => void) | undefined
    const stopped = new Promise<undefined>((resolve) => {
      aborted = () => resolve(undefined)
      signal.addEventListener('abort', aborted, { once: true })
    })
    try {
      // An admitted writer remains owned by its queue after this caller's allowance expires.
      return await Promise.race([operation().catch(() => undefined), stopped])
    } finally {
      if (aborted) {
        signal.removeEventListener('abort', aborted)
      }
    }
  }

  private async reconcile<T>(args: {
    selected: readonly MessageRow[]
    direct: boolean
    revalidate: () => void
    claimId?: string
    verifySelected?: CheckMailTargetVerification
    finalize: (messages: MessageRow[], heldAny: boolean) => T
    commit?: (take: () => T) => T
  }): Promise<T> {
    await this.within(() => Promise.resolve())
    this.assertCurrent(args.revalidate)
    const ids = args.selected.map((message) => message.id)
    const selectedById = new Map(args.selected.map((message) => [message.id, message]))
    for (;;) {
      this.assertCurrent(args.revalidate)
      const attempts = this.db.getStructuredMailSendsForMessages(ids)
      const observedSet = reservationSet(attempts)
      let hold: StructuredMailSourceHold | undefined
      const observations: JournalMailObservation[] = []
      try {
        for (const attempt of attempts) {
          await this.within(() => this.host.withdraw(attempt.session_id, attempt.operation_id))
          this.assertCurrent(args.revalidate)
        }
        const source = getStructuredAgentSessionHost()
        if (args.direct && source && attempts.length) {
          const signal = AbortSignal.any([
            this.deadline.signal,
            ...(this.signal ? [this.signal] : [])
          ])
          hold = await this.within(() => source.holdMailSources(attempts, signal))
          this.assertCurrent(args.revalidate)
          // The deadline may win just as acquisition returns; the aborted signal releases that hold.
          if (hold && !hold.current()) {
            hold.release()
            hold = undefined
          }
          for (const entry of hold?.observations ?? []) {
            observations.push(entry.observation)
          }
        } else if (!args.direct) {
          for (const attempt of attempts) {
            observations.push(
              (await this.within(() => this.host.observeMail!(attempt))) ?? UNKNOWN_MAIL
            )
            this.assertCurrent(args.revalidate)
          }
        }
        const targetVerification = args.verifySelected
          ? await args.verifySelected(args.selected)
          : undefined
        this.assertCurrent(args.revalidate)
        let onHeldAfterCommit: (() => void) | undefined
        const take = () =>
          runLifecycleWriteTransaction(this.db.db, 'check_reconciled_mail', () => {
            this.assertCurrent(args.revalidate)
            const current = this.db.getStructuredMailSendsForMessages(ids)
            const sameReservations = reservationSet(current) === observedSet
            if (!sameReservations && !this.deadline.signal.aborted) {
              throw new ChangedMailReservation()
            }
            const verified = targetVerification?.reverifySync()
            const allowedIds = verified?.allowedIds
            onHeldAfterCommit = verified?.onHeld
            const evidenceCurrent =
              sameReservations &&
              !this.deadline.signal.aborted &&
              (!args.direct || source === getStructuredAgentSessionHost()) &&
              (!args.direct || (hold?.current() ?? attempts.length === 0))
            const active = args.selected.flatMap((original) => {
              const message = currentUnreadMatch(this.db, original)
              return message && (!allowedIds || allowedIds.has(original.id)) ? [message] : []
            })
            const activeIds = new Set(active.map((message) => message.id))
            for (const message of active) {
              reconcileLifecycleMessage(this.db, message)
            }
            if (evidenceCurrent) {
              attempts.forEach((attempt, index) => {
                if (!selectedById.has(attempt.message_id) || !activeIds.has(attempt.message_id)) {
                  return
                }
                settleStructuredMailAttempt(
                  this.db,
                  attempt,
                  observations[index] ?? UNKNOWN_MAIL,
                  () =>
                    this.runtime.structuredChatMailOwed(
                      attempt.session_id,
                      {
                        kind: 'agent',
                        senders: [],
                        orchestration: {
                          message: 'mail-notice',
                          mailbox: attempt.mailbox_handle,
                          dispatchId: null,
                          messages: [{ messageId: attempt.message_id, runId: '', from: '' }]
                        }
                      },
                      args.claimId
                    )
                )
              })
            }
            const messages = active.flatMap(
              (original) => currentUnreadMatch(this.db, original) ?? []
            )
            const heldAny = Boolean(
              allowedIds && args.selected.some((message) => !allowedIds.has(message.id))
            )
            return args.finalize(messages, heldAny)
          })
        this.assertCurrent(args.revalidate)
        const committed = args.commit ? args.commit(take) : take()
        onHeldAfterCommit?.()
        return committed
      } catch (error) {
        if (!(error instanceof ChangedMailReservation)) {
          throw error
        }
      } finally {
        hold?.release()
      }
    }
  }

  async takeDirect<T>(args: {
    selected: MessageRow[]
    revalidate: () => void
    respond: (messages: MessageRow[]) => T
    record?: (response: T) => void
    verifySelected?: CheckMailTargetVerification
  }): Promise<T> {
    return this.reconcile({
      ...args,
      direct: true,
      finalize: (messages) => {
        if (messages.length > 0) {
          this.db.markAsRead(
            messages.map((message) => message.id),
            this.taker
          )
        }
        const response = args.respond(messages)
        args.record?.(response)
        return response
      }
    })
  }

  async takeRole(args: {
    mailbox: MailboxDeliveryParams
    revalidate: () => void
    respond: (
      batch: MailboxDeliveryBatch | undefined
    ) => NonNullable<MailboxDeliveryBatch['finalResponse']>
    record?: (response: NonNullable<MailboxDeliveryBatch['finalResponse']>) => void
    wake?: MessageWake
    verifySelected?: CheckMailTargetVerification
  }): Promise<MailboxDeliveryBatch | undefined> {
    this.assertCurrent(args.revalidate)
    const key = `${args.mailbox.mailboxHandle}:${args.mailbox.consumerGeneration}`
    const select = () => this.db.getOrCreateMailboxDelivery(args.mailbox)
    const claim = args.wake ? args.wake.claim(key, select) : select()
    if (!claim) {
      return undefined
    }
    const shared = args.wake?.final(key)
    if (shared) {
      args.record?.(args.respond(shared))
      return shared
    }
    return this.reconcile({
      selected: claim.messages,
      direct: false,
      claimId: claim.delivery.id,
      revalidate: args.revalidate,
      verifySelected: args.verifySelected,
      commit: (take) => {
        const shared = args.wake?.final(key)
        if (shared) {
          args.record?.(args.respond(shared))
          return shared
        }
        // Publish the shared result only after the take and its receipt have committed.
        return args.wake ? args.wake.share(key, take) : take()
      },
      finalize: (messages, heldAny) => {
        if (messages.length === 0 && heldAny) {
          this.db.fenceOutstandingMailboxDelivery(
            claim.delivery.id,
            args.mailbox.consumerGeneration
          )
          return undefined
        }
        const batch = this.db.finalizeMailboxDelivery({
          ...args.mailbox,
          claim,
          messages,
          taker: this.taker
        })
        if (batch) {
          batch.finalResponse = args.respond(batch)
        }
        if (batch) {
          args.record?.(args.respond(batch))
        }
        return batch
      }
    })
  }
}
