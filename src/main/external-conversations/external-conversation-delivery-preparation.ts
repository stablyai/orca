import { z } from 'zod'
import { isBotAgent } from '../../shared/bot-types'
import { CONNECTOR_SOURCES } from '../../shared/connectors/external-conversation-link'
import { ConnectorAsker } from '../../shared/connector-asker-contract'
import type { LinkableChat } from './external-conversation-chat-delivery'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { rejectedSendRefusal } from './external-conversation-failure'
import { refusalOf } from './external-conversation-chain'
import type { DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import { refused, type Delivery } from './external-conversation-types'

export const PREPARING = JSON.stringify({ phase: 'preparing_attachments' })
export const ATTEMPT_PREFIX = '{"phase":"admitting_attachments",'
const RestorableAsker = ConnectorAsker.pick({ app: true, name: true, place: true, role: true })
const RestorableThread = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  botId: z.string(),
  title: z.string(),
  asker: RestorableAsker.optional()
})
export type RestorableThread = z.infer<typeof RestorableThread>
const AdmissionAttempt = z.object({
  phase: z.literal('admitting_attachments'),
  sessionId: z.string(),
  operationId: z.string(),
  thread: RestorableThread.optional()
})
export type DeliveryAdmissionAttempt = z.infer<typeof AdmissionAttempt>

export function admissionAttempt(receipt: string | null): DeliveryAdmissionAttempt | null {
  return receipt?.startsWith(ATTEMPT_PREFIX) ? AdmissionAttempt.parse(JSON.parse(receipt)) : null
}

/** Receipts for a turn and its batch can be retried until the turn is ready for admission. */
export class DeliveryPreparation {
  private readonly pending = new Set<string>()
  private receipt = PREPARING
  private laneSignal: { lane: AbortSignal; delivery: AbortSignal } | undefined
  private thread: RestorableThread | undefined
  private ledger: { db: DeliveryReceiptDb; fingerprint: string } | undefined

  constructor(
    private readonly pollSignal?: AbortSignal,
    private readonly msLeft?: () => number
  ) {}

  expired(): boolean {
    return (this.msLeft?.() ?? Infinity) <= 0
  }

  stopped(signal: AbortSignal): Delivery | null {
    if (this.expired() || signal.reason?.name === 'TimeoutError') {
      return { outcome: 'expired' }
    }
    return signal.aborted ? refused(refusalOf(signal)) : null
  }

  signal(lane: AbortSignal): AbortSignal {
    if (this.laneSignal?.lane === lane) {
      return this.laneSignal.delivery
    }
    const signals = this.pollSignal ? [lane, this.pollSignal] : [lane]
    if (this.msLeft) {
      const remaining = Math.min(2_147_483_647, Math.floor(this.msLeft()))
      signals.push(remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort())
    }
    const delivery = AbortSignal.any(signals)
    this.laneSignal = { lane, delivery }
    return delivery
  }

  pendingReceipt(): string {
    return this.receipt
  }

  track(db: DeliveryReceiptDb, fingerprint: string, requestId: string): () => void {
    this.ledger ??= { db, fingerprint }
    this.pending.add(requestId)
    return () => {
      this.pending.delete(requestId)
    }
  }

  restoreThreadOnRestart(thread: RestorableThread): void {
    this.thread = RestorableThread.parse(thread)
  }

  /** The writer's command receipt proves whether this particular attempt took effect. */
  attempting(sessionId: string, operationId: string): void {
    const receipt = JSON.stringify({
      phase: 'admitting_attachments',
      sessionId,
      operationId,
      ...(this.thread ? { thread: this.thread } : {})
    })
    if (this.pending.size && this.ledger) {
      const { db, fingerprint } = this.ledger
      db.checkpointPendingMutationReceipts(fingerprint, [...this.pending], receipt)
    }
    this.receipt = receipt
  }
}

export async function recoverConnectorAdmission(
  { sessionId, operationId, thread }: DeliveryAdmissionAttempt,
  ensureHost?: () => Promise<unknown>,
  restore?: (thread: RestorableThread, chat: LinkableChat) => void
): Promise<Delivery | null> {
  await ensureHost?.()
  const host = getStructuredAgentSessionHost()
  const conversation = host?.deps.store.getConversation(sessionId)
  if (host && conversation) {
    const read = await host.deps.store.readCommandReceipt({ kind: 'global' }, operationId)
    if (read.verdict === 'absent') {
      return null
    }
    if (
      read.verdict === 'readable' &&
      read.receipt.sessionId === sessionId &&
      read.receipt.method === 'agentSession.send'
    ) {
      if (read.receipt.status === 'rejected') {
        return null
      }
      const submission = await (await host.journalReads(sessionId)).submission(operationId)
      if (submission?.dispatchState === 'rejected') {
        return await rejectedSendRefusal(
          host,
          { sessionId, agent: conversation.provider },
          submission
        )
      }
      if (thread && isBotAgent(conversation.provider)) {
        restore?.(thread, {
          sessionId,
          agent: conversation.provider,
          worktreeId: conversation.location.workspaceId,
          bot: { kind: 'bot', botId: thread.botId }
        })
      }
      return submission?.dispatchState === 'unknown'
        ? { outcome: 'unknown', reason: 'writer_failed' }
        : { outcome: 'accepted' }
    }
  }
  return { outcome: 'unknown', reason: 'replayed_after_restart' }
}
