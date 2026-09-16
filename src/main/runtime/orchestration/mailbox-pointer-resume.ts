import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'

export function resumePendingOrchestrationMailboxPointer<
  TWaiter extends OrchestrationMessageWaiter
>(args: {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  enterDelayMs: number
  leafKey: string
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}): boolean {
  const ptyId = args.leaf.ptyId
  const newestSequence = args.messages.at(-1)?.sequence
  const expectedTarget = ptyId ? args.deps.resolveSubmitTarget(args.leaf, ptyId) : null
  const staged = args.messages[0]
  const messageIds = args.messages.map((message) => message.id)
  const phases = new Set(args.messages.map((message) => message.pointer_enter_pending))
  const persistedTarget = staged?.pointer_pty_id
    ? {
        ptyId: staged.pointer_pty_id,
        processIncarnation: staged.pointer_process_incarnation ?? ''
      }
    : null
  if (
    !ptyId ||
    newestSequence === undefined ||
    !expectedTarget ||
    !staged ||
    staged.pointer_pty_id !== ptyId ||
    staged.pointer_process_incarnation !== expectedTarget.processIncarnation ||
    args.messages.some(
      (message) =>
        message.pointer_pty_id !== staged.pointer_pty_id ||
        message.pointer_process_incarnation !== staged.pointer_process_incarnation
    )
  ) {
    const db = args.deps.getDb()
    if (db) {
      const byTarget = new Map<
        string,
        { target: { ptyId: string; processIncarnation: string }; ids: string[] }
      >()
      for (const message of args.messages) {
        if (!message.pointer_pty_id || !message.pointer_process_incarnation) {
          continue
        }
        const key = `${message.pointer_pty_id}\u0000${message.pointer_process_incarnation}`
        const group = byTarget.get(key) ?? {
          target: {
            ptyId: message.pointer_pty_id,
            processIncarnation: message.pointer_process_incarnation
          },
          ids: []
        }
        group.ids.push(message.id)
        byTarget.set(key, group)
      }
      for (const group of byTarget.values()) {
        db.releaseMailboxPointerEnter(group.ids, group.target, [
          MAILBOX_POINTER_RESERVED,
          MAILBOX_POINTER_WRITE_ATTEMPTED,
          MAILBOX_POINTER_ENTER_ATTEMPTED
        ])
      }
    }
    return false
  }
  if (phases.size !== 1 || !phases.has(MAILBOX_POINTER_RESERVED)) {
    // Same-incarnation recovery cannot tell whether pointer text or Enter reached the PTY.
    args.deps
      .getDb()
      ?.settleMailboxPointerEnter(messageIds, persistedTarget!, [
        MAILBOX_POINTER_WRITE_ATTEMPTED,
        MAILBOX_POINTER_ENTER_ATTEMPTED
      ])
    return true
  }
  args.deps
    .getDb()
    ?.releaseMailboxPointerEnter(messageIds, persistedTarget!, [MAILBOX_POINTER_RESERVED])
  return false
}
