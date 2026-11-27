import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationMailboxDeliveryTarget } from '../routing/mailbox-delivery-target'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type {
  OrchestrationMailboxOwner,
  OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import type {
  OrchestrationMailboxPointerSubmitTarget,
  OrchestrationPointerSubmitCheck
} from './mailbox-pointer-submit'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export type OrchestrationMailboxPointerMessage = {
  id: string
  type: string
  sequence: number
  pointer_enter_pending?: number
  pointer_pty_id?: string | null
  pointer_process_incarnation?: string | null
}

export type PointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  deliveryTarget: OrchestrationMailboxDeliveryTarget
  wakeSleepingRecipient?: (mailbox: string, reservedTypes?: ReadonlySet<string>) => void
  getDb: () => OrchestrationDb | null
  getTerminal: (ptyId: string) => OrchestrationMailboxTerminal | null
  /** Whether the terminal may take the pointer plus Enter now: at rest, or mid-turn (input queues). */
  isAgentSettledForDelivery: (ptyId: string) => boolean
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getCliCommand: (terminalHandle: string) => OrchestrationCliCommand
  resolveSubmitTarget: (ptyId: string) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
} & OrchestrationPointerPty

/** How delivery writes a pointer into its PTY and times the Enter after it. */
export type OrchestrationPointerPty = {
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  /** Enter's delay after `pointer` when the PTY's host is Windows; null keeps the default. */
  getWindowsPointerEnterDelayMs: (ptyId: string, pointer: string) => number | null
} & OrchestrationPointerSubmitCheck
