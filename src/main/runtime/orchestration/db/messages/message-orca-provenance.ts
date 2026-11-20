import { OrchestrationError } from '../../orchestration-error'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../shared/bots/bot-item-note-runs'

export type OrcaAuthoredMail = 'item-mail' | 'bot-request'

/** The sender and payload of mail some caller wrote: it may not pose as Orca's own item mail or
 *  carry a bot request's field, which make a receiver admit the payload's image paths. */
export function callerMailProvenance(msg: {
  from: string
  payload?: string
  orcaAuthored?: OrcaAuthoredMail
}): string | undefined {
  const { from, payload, orcaAuthored } = msg
  if (orcaAuthored === 'item-mail') {
    return payload
  }
  if (from === BOT_ITEM_MAIL_SENDER) {
    throw new OrchestrationError(
      'invalid_argument',
      `${BOT_ITEM_MAIL_SENDER} is Orca's own sender.`
    )
  }
  if (orcaAuthored === 'bot-request' || !payload) {
    return payload
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('botRequest' in parsed)) {
    return payload
  }
  return JSON.stringify(
    Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'botRequest'))
  )
}
