import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'

import type {
  AgentJournalMessageItem,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import type { JournalItemAppendOptions } from './journal-store-contracts'

import type { QueuedMessageRow } from './queued-messages/queued-message-table'

import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'

type JournalDomainItemFields = {
  identity: AgentJournalItemIdentity
  options: JournalItemAppendOptions
  scopeItemIds?: readonly string[]
}

export type JournalDomainItemWrite = JournalDomainItemFields &
  (
    | { kind: 'item'; body: AgentJournalItemBody }
    | {
        kind: 'text-snapshot'
        body: AgentJournalMessageItem
      }
  )

export type JournalDomainItemCommit = {
  cursor: AgentJournalCursor
  publicCursor?: AgentJournalCursor
  outcome:
    | { kind: 'committed'; wrote: boolean }
    | { kind: 'dropped'; reason: 'turn-settled'; turnItemId: string }
  items: AgentJournalRenderItem[]
  insertedItemIds?: string[]
  receipts: AgentJournalAcceptanceReceipt[]
  cards: QueuedMessageRow[]
  inputChanged: boolean
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
}
