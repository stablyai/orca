// What a bot request is sent with, once its sender and receiving bot are known.
import type { z } from 'zod'
import type { PairedSender } from '../../../../../../shared/orchestration/mailbox/paired-sender-name'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { ActingSender, ReceivingBot } from './bot-recipient'
import type { MailFilesClaim } from './bot-mail-files-claim'
import type { SendParams } from './send-params'

export type SendParamsInput = Pick<
  z.infer<typeof SendParams>,
  'subject' | 'body' | 'type' | 'priority' | 'threadId'
>

export type SendBotRequestArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: SendParamsInput
  from: string
  to: string
  receiving: ReceivingBot
  acting: ActingSender
  senderRunId: string | undefined
  senderPaneKey: string | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  messageId?: string
  /** Who sent it as the card shows them, for a sender this Orca has no record of (another computer's). */
  senderSnapshot?: string
  /** Its sender is an agent on a computer paired with this one, either side of the pairing. */
  pairedSender?: PairedSender
  /** Store images claimed for the receiving chat (`send --item --file`). */
  images?: readonly string[]
  /** Nudges the sender runs later instead of now. */
  held?: (() => void)[]
  /** Commits with the request's admission, before anyone is woken for it. */
  onAdmitted?: () => void
  /** A paired Orca's files with no item: claimed for the chat it is stored in, as it is stored. */
  claimFiles?: MailFilesClaim
}
