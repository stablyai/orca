import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { structuredMailboxCustody } from '../../../../orchestration/mailbox/routing/structured-session-mail-target'
import { readStructuredMailAdmitFacts } from '../../../../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host'
import {
  describeMailboxDeliveryHold,
  readMailboxDeliveryHold
} from '../../../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import type { SendRecipientWarning } from './recipient-routing'

/** The receipt line for mail the delivery gate would hold right now; null when it would deliver.
 *  Never throws: the mail is already stored, so a failed read must not fail the send. */
export async function sendDeliveryHoldWarning(
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold'>,
  db: OrchestrationDb,
  recipient: string
): Promise<SendRecipientWarning | null> {
  try {
    return await readDeliveryHoldWarning(runtime, db, recipient)
  } catch (error) {
    console.warn('[orchestration] delivery hold read failed', recipient, error)
    return null
  }
}

async function readDeliveryHoldWarning(
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold'>,
  db: OrchestrationDb,
  recipient: string
): Promise<SendRecipientWarning | null> {
  const hold = await readMailboxDeliveryHold(recipient, {
    chatSessionFor: (mailbox) => {
      const custody = structuredMailboxCustody(mailbox, db)
      return typeof custody === 'object' ? custody.sessionId : null
    },
    readChatAdmit: readStructuredMailAdmitFacts,
    terminalFor: (mailbox) => {
      if (mailbox.startsWith('run:')) {
        return mailbox
      }
      if (!mailbox.startsWith('dispatch:')) {
        return mailbox
      }
      const dispatch = db.getDispatchContextById(mailbox.slice('dispatch:'.length))
      return dispatch?.status === 'dispatched' ? dispatch.assignee_handle : null
    },
    readTerminalHold: (handle) => runtime.readTerminalMailHold(handle)
  })
  return hold &&
    (!recipient.startsWith('run:') || hold.kind === 'not-foreground' || hold.kind === 'not-live')
    ? {
        code: 'recipient_delivery_held',
        recipient,
        message: describeMailboxDeliveryHold(recipient, hold)
      }
    : null
}

/** A stored send's receipt with the hold line added, when the delivery gate would hold it. */
export async function withDeliveryHoldWarning<T>(
  sent: T,
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold'>,
  db: OrchestrationDb,
  recipient: string
): Promise<T | (T & { warnings: unknown[] })> {
  const held = await sendDeliveryHoldWarning(runtime, db, recipient)
  if (!held || typeof sent !== 'object' || sent === null) {
    return sent
  }
  const prior = 'warnings' in sent && Array.isArray(sent.warnings) ? sent.warnings : []
  return { ...sent, warnings: [...prior, held] }
}

/** A paired server's worker: this Orca sees only that the relay took the mail. */
export function relayedDeliveryUnknownWarning(recipient: string): SendRecipientWarning {
  return {
    code: 'recipient_delivery_unknown',
    recipient,
    message: `Accepted for relay to the server running ${recipient}; its delivery state is unknown here.`
  }
}
