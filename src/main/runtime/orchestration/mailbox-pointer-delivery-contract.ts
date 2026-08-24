import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'

export type PointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  deliveryTarget: OrchestrationMailboxDeliveryTarget
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getLiveLeafForHandle: (handle: string) => OrchestrationMailboxLeaf
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTabTitle: (tabId: string) => string | null | undefined
  getTerminalHandleForLeaf: (leaf: OrchestrationMailboxLeaf) => string | undefined
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  sendPrompt: (
    handle: string,
    prompt: string,
    options: { signal: AbortSignal; beforeWrite: () => void; beforeAttempt: () => void }
  ) => Promise<'delivered' | 'unknown' | 'rejected'>
}
