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
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold' | 'getTerminalOrchestrationCliCommand'>,
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
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold' | 'getTerminalOrchestrationCliCommand'>,
  db: OrchestrationDb,
  recipient: string
): Promise<SendRecipientWarning | null> {
  if (recipient.startsWith('dispatch:')) {
    const dispatch = db.getDispatchContextById(recipient.slice('dispatch:'.length))
    // Mail to a Dispatch not running now follows its Task, not a terminal's note.
    if (dispatch?.status !== 'dispatched') {
      return null
    }
  }
  const hold = await readMailboxDeliveryHold(recipient, {
    chatSessionFor: (mailbox) => {
      const custody = structuredMailboxCustody(mailbox, db)
      return typeof custody === 'object' ? custody.sessionId : null
    },
    readChatAdmit: readStructuredMailAdmitFacts,
    readTerminalHold: (mailbox) => runtime.readTerminalMailHold(mailbox)
  })
  return hold
    ? {
        code: 'recipient_delivery_held',
        recipient,
        message: describeMailboxDeliveryHold(
          recipient,
          hold,
          // The receiver runs the command, so name the CLI its own terminal resolves.
          hold.kind === 'unverified'
            ? runtime.getTerminalOrchestrationCliCommand(hold.terminal)
            : undefined
        )
      }
    : null
}

/** A stored send's receipt with the hold line added, when the delivery gate would hold it. A message
 *  a waiting `check --wait` took is read by that call, so no hold applies to it. */
export async function withDeliveryHoldWarning<T>(
  sent: T,
  runtime: Pick<OrcaRuntimeService, 'readTerminalMailHold' | 'getTerminalOrchestrationCliCommand'>,
  db: OrchestrationDb,
  recipient: string,
  takenByWaiter: boolean
): Promise<T | (T & { warnings: unknown[] })> {
  const held =
    takenByWaiter || isLifecycleRejection(sent)
      ? null
      : await sendDeliveryHoldWarning(runtime, db, recipient)
  if (!held || typeof sent !== 'object' || sent === null) {
    return sent
  }
  const prior = 'warnings' in sent && Array.isArray(sent.warnings) ? sent.warnings : []
  return { ...sent, warnings: [...prior, held] }
}

// A refused lifecycle message is stored as a status rejection the receipt already reports; it is not
// the sender's mail waiting to be read, so no hold advice applies.
function isLifecycleRejection(sent: unknown): boolean {
  return (
    typeof sent === 'object' &&
    sent !== null &&
    'lifecycle' in sent &&
    typeof sent.lifecycle === 'object' &&
    sent.lifecycle !== null &&
    'action' in sent.lifecycle &&
    sent.lifecycle.action === 'rejected'
  )
}

/** A paired server's worker: this Orca sees only that the relay took the mail. */
export function relayedDeliveryUnknownWarning(recipient: string): SendRecipientWarning {
  return {
    code: 'recipient_delivery_unknown',
    recipient,
    message: `Accepted for relay to the server running ${recipient}; its delivery state is unknown here.`
  }
}
