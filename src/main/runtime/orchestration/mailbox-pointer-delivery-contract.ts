import type { TerminalMailboxSubscriptions } from './terminal-mailbox-subscriptions'
import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxOwner, OrchestrationMailboxTerminal } from './mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import type { OrchestrationCliCommand } from './cli-command'
import type { WriteSettlement } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export type OrchestrationMailboxPointerMessage = {
  id: string
  type: string
  sequence: number
  pointer_enter_pending?: number
  pointer_pty_id?: string | null
  pointer_process_incarnation?: string | null
}

export type PointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  terminalSubscriptions?: TerminalMailboxSubscriptions
  resolveSubscriptionTarget?: (handle: string) => OrchestrationMailboxPointerSubmitTarget | null
  mailboxOwner: Pick<OrchestrationMailboxOwner, 'resolve'>
  deliveryTarget: Pick<
    OrchestrationMailboxDeliveryTarget,
    'resolveTerminal' | 'deferForAbsenceProbe'
  >
  getDb: () => OrchestrationDb | null
  getTerminal: (ptyId: string) => OrchestrationMailboxTerminal | null
  /** Whether the terminal may take the pointer plus Enter now: at rest, or mid-turn (input queues). */
  isAgentSettledForDelivery: (ptyId: string) => boolean
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getCliCommand: (terminalHandle: string) => OrchestrationCliCommand
  resolveSubmitTarget: (
    ptyId: string,
    mailboxHandle?: string
  ) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
}
