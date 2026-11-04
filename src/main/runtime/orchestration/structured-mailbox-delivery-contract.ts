import type { OrchestrationDb } from './db'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderSnapshotResolver } from './agent-message-sender'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'

export type StructuredPointerTarget = {
  sessionId: string
  /** Direct peer mail has no Dispatch; that absence must not prevent worker nudges. */
  dispatchId: string | null
}

export type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /** Resolve dispatch or direct-worker mail to its session; null delegates to the PTY lane. */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  /** The runtime's own delivery for a mailbox, whichever lane owns it: a terminal's included. */
  redeliver?: (mailboxHandle: string) => void
  scheduleRedelivery?: (mailboxHandle: string) => void
  /** Whether nothing can own the mailbox again; read from the database unless a test supplies it. */
  mailboxEnded?: (mailboxHandle: string) => boolean
  /** Why no chat resolves a mailbox; read from the database unless a test supplies it. */
  unresolvedCustody?: (mailboxHandle: string) => 'elsewhere' | 'unverifiable'
  /** The CLI name the recipient runs, for the reply line and the oversized-message pointer. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderSnapshot: SenderSnapshotResolver
  host: StructuredMailboxPointerHost
}
