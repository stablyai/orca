import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import type { CommandReceiptRead } from '../../native-chat/agent-session-journal/command-receipt-table'
import type { OrchestrationDb } from './db'
import {
  reconcileStructuredMailInput,
  recordStructuredMailHandoff as record
} from './structured-mailbox-pointer-receipt'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import { structuredMailSource } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredDispatchState,
  StructuredPointerRetainReason
} from './structured-session-pointer-delivery'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { reconcileLegacyMailHandoff } from './legacy-mail-handoff'
import {
  structuredMailMaySubmit,
  mailTransportWasRefused,
  selectStructuredMailHandoff,
  type StructuredMailEvidence
} from './mailbox-settlement'

export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome =
  | {
      kind: 'sent'
      state: StructuredDispatchState
      clientMessageId?: string
      nonAdmission?: 'refused' | 'expired'
    }
  | { kind: 'held' }
  | { kind: 'superseded'; noEffect?: boolean }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued'; clientMessageId?: string }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = Pick<StructuredMailEvidence, 'epoch' | 'frontier'>
type MailEvidenceSource = Pick<StructuredMailHandoff, 'sessionId' | 'clientMessageId'>

export type StructuredMailboxPointerHost = {
  readReceipt?: (reference: StructuredMailHandoff) => CommandReceiptRead
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  readHandoffEvidence: (reference: MailEvidenceSource) => Promise<StructuredMailEvidence | null>
  readHandoffEvidenceNow: (reference: MailEvidenceSource) => StructuredMailEvidence | null
  hasActionablePromptNow: (sessionId: string) => boolean | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
    beforeRun: () => boolean
  }) => Promise<StructuredPointerSendOutcome>
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}

type ParkedDelivery = { sessionId: string; reservedTypes: ReadonlySet<string> | undefined }
type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  private readonly parkedUntilJournalEdge = new Map<string, ParkedDelivery>()
  private readonly changedDuringFlight = new Set<string>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    if (this.inFlight.has(mailboxHandle)) {
      this.changedDuringFlight.add(mailboxHandle)
      return true
    }
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => undefined)
    return true
  }

  onJournalActivity(sessionId: string): void {
    for (const [mailbox, parked] of this.parkedUntilJournalEdge) {
      if (parked.sessionId === sessionId) {
        this.deliverForHandle(mailbox, parked.reservedTypes)
      }
    }
  }

  forgetSession(sessionId: string): void {
    for (const [mailbox, parked] of this.parkedUntilJournalEdge) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailbox)
      }
    }
  }

  private async deliver(
    mailbox: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    this.inFlight.add(mailbox)
    this.parkedUntilJournalEdge.set(mailbox, { sessionId: target.sessionId, reservedTypes })
    try {
      const reconciled = new Set<string>()
      const replanned = new Set<string>()
      for (;;) {
        const db = this.deps.getDb()
        if (!db) {
          return
        }
        const session = await this.deps.host.readSessionFacts(target.sessionId)
        const fence = this.deps.host.currentFence(target.sessionId)
        if (!session || fence === null) {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        await reconcileLegacyMailHandoff(db, mailbox, target.sessionId, this.deps.host)
        const batch = await selectStructuredMailHandoff({
          db,
          mailbox,
          sessionId: target.sessionId,
          epoch: session.epoch,
          frontier: session.frontier,
          waiters: this.deps.getMessageWaiters(mailbox),
          reservedTypes,
          readEvidence: (reference) => this.deps.host.readHandoffEvidence(reference),
          skipOperations: reconciled,
          manifest: (messages) => ({
            members: messages.map((message) => message.id),
            dispatchId: target.dispatchId,
            runtimeFence: fence,
            context: this.deps.host.currentContextClearOperationId(target.sessionId),
            body: JSON.stringify({
              kind: 'message',
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  text: formatMessagePointer(
                    messages.length,
                    mailbox,
                    this.deps.getCliCommand()
                  ).trim()
                }
              ],
              from: structuredMailSource({
                db,
                mailboxHandle: mailbox,
                dispatchId: target.dispatchId,
                batch: messages,
                senderName: this.deps.senderName
              })
            })
          })
        })
        if (!batch) {
          if (
            !db.getAutomaticMailCandidates(mailbox, {
              afterSequence: 0,
              excludeTypes: [],
              limit: 1
            }).length
          ) {
            this.parkedUntilJournalEdge.delete(mailbox)
          }
          return
        }
        let { messages, reference } = batch
        const manifest = reference.manifest
        if (
          !manifest ||
          !reconcileStructuredMailInput(this.deps.host, db, mailbox, messages, reference)
        ) {
          reconciled.add(reference.operationId)
          continue
        }
        const current = (): boolean => {
          const next = this.deps.resolveStructuredTarget(mailbox)
          return (
            next?.sessionId === target.sessionId &&
            next.dispatchId === target.dispatchId &&
            this.deps.host.currentContextClearOperationId(target.sessionId) === manifest.context &&
            this.deps.host.currentFence(target.sessionId) === manifest.runtimeFence &&
            manifest.members.length === messages.length &&
            manifest.members.every((id, index) => messages[index]?.id === id) &&
            db.isMailHandoffCurrent(mailbox, messages, reference.authority) &&
            messages.every((message) => {
              const reserved = readMailHandoff(message.handoff)
              return (
                reserved?.kind === 'structured' &&
                structuredMailMaySubmit(reserved, this.deps.host.readHandoffEvidenceNow)
              )
            })
          )
        }
        if (!current()) {
          if (reference.nonAdmission && !replanned.has(reference.operationId)) {
            replanned.add(reference.operationId)
            record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
          } else {
            reconciled.add(reference.operationId)
          }
          continue
        }
        const body: unknown = JSON.parse(manifest.body)
        if (!isAdmissibleAgentJournalMessageBody(body)) {
          return
        }
        const neverAdmitted = Boolean(reference.nonAdmission)
        record(db, mailbox, messages, ({ nonAdmission: _result, ...member }) => member)
        messages = messages
          .map((message) => db.getMessageById(message.id))
          .filter((message) => message !== undefined)
        const attempt = readMailHandoff(messages[0]?.handoff)
        if (attempt?.kind !== 'structured') {
          return
        }
        reference = attempt
        const outcome = await this.deps.host.send({
          sessionId: target.sessionId,
          dispatchId: target.dispatchId,
          operationId: reference.operationId,
          expectedRuntimeFence: manifest.runtimeFence,
          body,
          beforeRun: current
        })
        if (outcome.kind === 'held') {
          record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
          this.retain(mailbox, target.sessionId, 'turn-unsettled')
          return
        }
        if (outcome.kind === 'unattached') {
          this.retain(mailbox, target.sessionId, 'session-not-attached')
          return
        }
        if (outcome.kind === 'superseded') {
          if (!outcome.noEffect || replanned.has(reference.operationId)) {
            reconciled.add(reference.operationId)
          }
          if (outcome.noEffect) {
            record(db, mailbox, messages, (member) => ({ ...member, nonAdmission: 'held' }))
            replanned.add(reference.operationId)
          }
          continue
        }
        if (outcome.kind === 'sent' && outcome.state !== 'accepted') {
          const nonAdmission =
            outcome.nonAdmission === 'expired' && !neverAdmitted ? undefined : outcome.nonAdmission
          if (nonAdmission === 'expired') {
            this.changedDuringFlight.add(mailbox)
          }
          const evidence = this.deps.host.readHandoffEvidenceNow(reference)
          if (nonAdmission || (evidence && mailTransportWasRefused(evidence))) {
            record(db, mailbox, messages, (member) => ({
              ...member,
              nonAdmission: nonAdmission ?? 'refused'
            }))
          }
          this.retain(
            mailbox,
            target.sessionId,
            outcome.state === 'rejected' ? 'dispatch-rejected' : 'turn-unsettled'
          )
          return
        }
        record(db, mailbox, messages, (member) => ({
          ...member,
          phase: 'offered',
          clientMessageId: outcome.clientMessageId ?? reference.clientMessageId
        }))
        reservedTypes = undefined
        const next = this.deps.resolveStructuredTarget(mailbox)
        if (!next || next.sessionId !== target.sessionId) {
          return
        }
        target = next
      }
    } finally {
      this.inFlight.delete(mailbox)
      if (this.changedDuringFlight.delete(mailbox)) {
        queueMicrotask(() => this.deliverForHandle(mailbox, reservedTypes))
      }
    }
  }

  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
  }
}
