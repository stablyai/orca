import { followThroughWorkerReport, settledDispatchId } from './settled-worker-follow-through'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { structuredMailboxCustody } from '../../../../orchestration/mailbox/routing/structured-session-mail-target'
import {
  readStructuredMailAdmitFacts,
  createStructuredMailboxPointerHost
} from '../../../../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host'
import {
  describeMailboxDeliveryHold,
  readMailboxDeliveryHold
} from '../../../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import type { SendRecipientWarning } from './recipient-routing'
import {
  heldWorkerDeliveryText,
  unconfirmedMessageDelivery as unknownStoredDelivery,
  type AgentSessionHeldDelivery
} from '../../../../../../shared/agent-session/agent-session-held-delivery'
import type { OrchestrationPartyIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { runBoundToCoordinator } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { currentRunCoordinatorOrcaSessionId } from '../../../../orchestration/db/runs/run-coordinator-orca-session'
import { formatOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { workerDeliveryName } from './worker-delivery-name'
export { unknownStoredDelivery }

type DeliveryWarning = SendRecipientWarning & { held?: AgentSessionHeldDelivery; busy?: true }

/** The receipt line for mail the delivery gate would hold right now; null when it would deliver.
 *  Never throws: the mail is already stored, so a failed read must not fail the send. */
export async function sendDeliveryHoldWarning(
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold'>,
  db: OrchestrationDb,
  recipient: string
): Promise<DeliveryWarning | null> {
  try {
    return await readDeliveryHoldWarning(runtime, db, recipient)
  } catch (error) {
    console.warn('[orchestration] delivery hold read failed', recipient, error)
    return {
      code: 'recipient_delivery_unknown',
      recipient,
      message: 'Message kept. Delivery is unconfirmed.'
    }
  }
}

async function readDeliveryHoldWarning(
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold'>,
  db: OrchestrationDb,
  recipient: string
): Promise<DeliveryWarning | null> {
  if (recipient.startsWith('run:')) {
    return null
  }
  const hold = await readMailboxDeliveryHold(recipient, {
    chatSessionFor: (mailbox) => {
      const custody = structuredMailboxCustody(mailbox, db)
      return typeof custody === 'object' ? custody.sessionId : null
    },
    readChatAdmit: readStructuredMailAdmitFacts,
    terminalFor: (mailbox) => {
      if (!mailbox.startsWith('dispatch:')) {
        return mailbox
      }
      const dispatch = db.getDispatchContextById(mailbox.slice('dispatch:'.length))
      return dispatch?.status === 'dispatched' ? dispatch.assignee_handle : null
    },
    readTerminalHold: (handle) => runtime.readTerminalMailHold(handle)
  })
  return hold
    ? {
        code: hold.kind === 'unreadable' ? 'recipient_delivery_unknown' : 'recipient_delivery_held',
        recipient,
        ...(hold.kind === 'worker-failed' ? { held: hold.delivery } : {}),
        ...(hold.kind === 'busy' ? { busy: true as const } : {}),
        message: describeMailboxDeliveryHold(recipient, hold)
      }
    : null
}

/** A stored send's receipt with the hold line added, when the delivery gate would hold it. */
export async function withDeliveryHoldWarning<T>(
  sent: T,
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold' | 'orchestrationSenderNames'>,
  db: OrchestrationDb,
  recipient: string,
  caller?: OrchestrationPartyIdentity
) {
  try {
    return await readStoredSendDelivery(sent, runtime, db, recipient, caller)
  } catch {
    return unknownStoredDelivery(sent, recipient)
  }
}

async function readStoredSendDelivery<T>(
  sent: T,
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold' | 'orchestrationSenderNames'>,
  db: OrchestrationDb,
  recipient: string,
  caller?: OrchestrationPartyIdentity
) {
  if (typeof sent !== 'object' || sent === null) {
    return sent
  }
  const message =
    'message' in sent && sent.message && typeof sent.message === 'object' ? sent.message : null
  const id = message && 'id' in message && typeof message.id === 'string' ? message.id : undefined
  const dispatch = recipient.startsWith('dispatch:')
    ? db.getDispatchContextById(recipient.slice('dispatch:'.length))
    : undefined
  const custody = structuredMailboxCustody(recipient, db)
  const target = {
    address: recipient,
    ...(typeof custody === 'object' ? { sessionId: custody.sessionId } : {}),
    ...(dispatch ? { dispatchId: dispatch.id } : {})
  }
  const base = { ...sent, target }
  if (id) {
    const saved = db.getMessageById(id)
    const attempt = db.getStructuredMailSend(recipient, id)
    const observed = attempt
      ? await createStructuredMailboxPointerHost()
          .observeMail?.(attempt)
          .catch(() => undefined)
      : undefined
    if (saved?.read || observed?.state.kind === 'accepted') {
      return { ...base, delivered: true, state: 'delivered', deliveryMessage: 'Delivered.' }
    }
    if (attempt && (!observed || ['unreadable', 'unknown'].includes(observed.state.kind))) {
      return unknownStoredDelivery(base, recipient)
    }
  }
  const held = await sendDeliveryHoldWarning(runtime, db, recipient)
  if (custody === 'unverifiable' || held?.code === 'recipient_delivery_unknown') {
    return unknownStoredDelivery(base, recipient)
  }
  if (held?.held) {
    const run = dispatch ? db.getRun(dispatch.run_id) : undefined
    const coordinatorId = run && currentRunCoordinatorOrcaSessionId(run)
    const coordinatorAddress =
      run?.coordinator_handle ??
      (coordinatorId ? formatOrcaSessionAddress(coordinatorId) : undefined)
    const outcome: AgentSessionHeldDelivery = {
      ...held.held,
      target: { ...held.held.target, ...target }
    }
    const text = heldWorkerDeliveryText(outcome, {
      worker: workerDeliveryName(runtime, recipient) ?? recipient,
      owner: 'the owner',
      coordinator: coordinatorAddress ? workerDeliveryName(runtime, coordinatorAddress) : undefined,
      provider: formatAgentTypeLabel(outcome.provider),
      canResume: !!(run && caller && runBoundToCoordinator(run, caller))
    })
    return { ...sent, ...outcome, deliveryMessage: text.message, deliveryHint: text.hint }
  }
  const worker = workerDeliveryName(runtime, recipient) ?? recipient
  return {
    ...base,
    delivered: false,
    state: 'queued',
    deliveryMessage: `${held?.message ?? `Queued: ${worker} is waiting. Delivers when it's ready.`} Don't resend.`
  }
}

/** A paired server's worker: this Orca sees only that the relay took the mail. */
export function relayedDeliveryUnknownWarning(recipient: string): SendRecipientWarning {
  return {
    code: 'recipient_delivery_unknown',
    recipient,
    message: `Message kept for ${recipient}. Delivery is unconfirmed on its host.`
  }
}

export async function finishStoredSend(
  sent: unknown,
  {
    runtime,
    db,
    recipient,
    type,
    relayed,
    caller,
    recordMutationReceipt
  }: {
    runtime: OrcaRuntimeService
    db: OrchestrationDb
    recipient: string
    type?: string
    relayed: boolean
    caller?: OrchestrationPartyIdentity
    recordMutationReceipt?: (receipt: unknown) => void
  }
) {
  followThroughWorkerReport(
    runtime,
    db,
    type === 'worker_done' ? settledDispatchId(sent) : undefined
  )
  if (type === 'worker_done' || type === 'heartbeat') {
    return sent
  }
  const delivery = relayed
    ? unknownStoredDelivery(sent, recipient)
    : await withDeliveryHoldWarning(sent, runtime, db, recipient, caller)
  recordReceiptBeforeNudge(recordMutationReceipt, delivery, () => undefined)
  return delivery
}
