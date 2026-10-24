import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import type { OrchestrationCliCommand } from './cli-command'
import type { WriteSettlement } from '../../../shared/pty-write-settlement'
import type { TerminalMailTarget } from '../../agent-hooks/server/terminal-mail-target'

export type OrchestrationMailboxPointerMessage = {
  id: string
  type: string
  sequence: number
  handoff?: string | null
  pointer_enter_pending?: number
  pointer_pty_id?: string | null
  pointer_process_incarnation?: string | null
}

export type PointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  deliveryTarget: OrchestrationMailboxDeliveryTarget
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getLiveLeafForHandle: (handle: string) => OrchestrationMailboxLeaf
  /** Whether the pane is settled enough to type the pointer plus Enter into it. */
  isAgentSettledForDelivery: (leaf: OrchestrationMailboxLeaf) => boolean
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTabTitle: (tabId: string) => string | null | undefined
  getCliCommand: (terminalHandle: string) => OrchestrationCliCommand
  getTerminalHandleForLeafKey: (leafKey: string) => string | undefined
  resolveSubmitTarget: (
    leaf: OrchestrationMailboxLeaf,
    ptyId: string
  ) => OrchestrationMailboxPointerSubmitTarget | null
  readMailTarget?: (leaf: OrchestrationMailboxLeaf) => TerminalMailTarget | null
  mailTargetWasAbandoned?: (target: TerminalMailTarget) => boolean
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
}
