import type { MessageType } from '../../types'

export const ORCHESTRATION_DELIVERY_BATCH_LIMIT = 50

export type MailboxRoutingPage = {
  routedCount: number
  hasMore: boolean
  types: MessageType[]
}

export type ForeignDirectMailboxRoutingPage = MailboxRoutingPage & {
  mailboxes: { mailboxHandle: string; types: MessageType[] }[]
}
