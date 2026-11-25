import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import type { OrchestrationCliCommand } from '../orchestration/workers/launch/orchestration-cli-command'
import { OrchestrationMailboxPointerDelivery } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-delivery'
import type { OrchestrationPointerPty } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-delivery-contract'
import type { RuntimeMessageWaiter } from '../orchestration/mailbox/runtime-message-waiters'
import type {
  OrchestrationMailboxOwner,
  OrchestrationMailboxTerminal
} from '../orchestration/mailbox/routing/mailbox-owner'
import type { OrchestrationMailboxDeliveryTarget } from '../orchestration/mailbox/routing/mailbox-delivery-target'
import type { OrchestrationMailboxPointerSubmitTarget } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-submit'
import type { RunOpenCodeSessionBinding } from '../orchestration/addressing/run-opencode-session-binding'

export type RuntimeMailboxPointerHost = {
  orchestrationMailboxOwner: OrchestrationMailboxOwner
  orchestrationMailboxDeliveryTarget: OrchestrationMailboxDeliveryTarget
  openCodeSessionBinding: RunOpenCodeSessionBinding
  _orchestrationDb: OrchestrationDb | null
  messageWaiters: ReadonlyMap<string, ReadonlySet<RuntimeMessageWaiter>>
  getOrchestrationMailboxTerminal(ptyId: string): OrchestrationMailboxTerminal | null
  checkDeliverySettledAndArmRecheck(ptyId: string): boolean
  isPtyAwaitingUserInput(ptyId: string): boolean
  getTerminalOrchestrationCliCommand(handle: string): OrchestrationCliCommand
  resolveOrchestrationPointerSubmitTarget(
    ptyId: string
  ): OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent(ptyId: string): Promise<boolean>
  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void
  orchestrationPointerPty(): OrchestrationPointerPty
}

export function createRuntimeMailboxPointerDelivery(host: RuntimeMailboxPointerHost) {
  return new OrchestrationMailboxPointerDelivery<RuntimeMessageWaiter>({
    mailboxOwner: host.orchestrationMailboxOwner,
    deliveryTarget: host.orchestrationMailboxDeliveryTarget,
    getDb: () => host._orchestrationDb,
    getTerminal: (ptyId) => host.getOrchestrationMailboxTerminal(ptyId),
    isAgentSettledForDelivery: (ptyId) => host.checkDeliverySettledAndArmRecheck(ptyId),
    isPtyAwaitingUserInput: (ptyId) => host.isPtyAwaitingUserInput(ptyId),
    getMessageWaiters: (handle) => host.messageWaiters.get(handle),
    getCliCommand: (handle) => host.getTerminalOrchestrationCliCommand(handle),
    resolveSubmitTarget: (ptyId) => host.resolveOrchestrationPointerSubmitTarget(ptyId),
    isLeafPtyProvenAbsent: (ptyId) => host.isLeafPtyProvenAbsent(ptyId),
    redriveMailbox: (handle, reservedTypes) =>
      host.deliverPendingMessagesForHandle(handle, reservedTypes),
    ...host.orchestrationPointerPty(),
    getRunSessionPrompt: (runId) => host.openCodeSessionBinding.promptFor(runId)
  })
}
