import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalMailSource } from '../../native-chat/agent-session-journal/journal-mail-boundary'
import type { OrchestrationDb, MessageRow } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { MailCreationOperation } from './structured-mail-operation-identity'
import type { MailCreationHistory } from './structured-mail-creation-history'
import type { MailAdmission } from './structured-mail-source-discovery'
export type StructuredPointerTarget = { sessionId: string; dispatchId: string | null }
export type StructuredPointerSendOutcome = {
  kind: 'queued' | 'unattached' | 'held' | 'capacity' | 'retry'
}
export type StructuredMailboxPointerHost = {
  readCreation: (operationId: string, sessionId: string) => 'accepted' | 'absent' | 'unknown'
  selectCreation?: (source: Pick<MessageRow, 'run_id' | 'id'>) => MailCreationOperation
  readHistory: (sessionId: string) => MailCreationHistory
  observeHistory?: (listener: (members: ReadonlySet<string>) => void) => (() => void) | undefined
  admission: (sessionId: string) => MailAdmission | null
  currentFence: (sessionId: string) => number | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    beforeRun: () => void
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
    mailSource: JournalMailSource
  }) => Promise<StructuredPointerSendOutcome>
}
export function ordinaryMailCreationId(message: Pick<MessageRow, 'run_id' | 'id'>): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(['ordinary-mail-v1', message.run_id, message.id]))
    .digest('hex')
  return `0000000000001-${hash.slice(0, 32)}`
}

export type MailDeliveryDependencies<T extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailbox: string) => ReadonlySet<T> | undefined
  resolveStructuredTarget: (mailbox: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  scheduleRetry?: (mailbox: string) => void
  cancelRetry?: (mailbox: string) => void
  onRetain?: (input: { mailboxHandle: string; sessionId: string; reason: string }) => void
}
