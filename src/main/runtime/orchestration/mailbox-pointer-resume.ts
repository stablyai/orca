import { isTerminalMailbox } from './terminal-mailbox-subscriptions'
import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'

/** Classifies persisted pointer reservations against the terminal's current process; it owns no live flight. */
export function resumePendingOrchestrationMailboxPointer(args: {
  deps: Pick<
    PointerDeliveryDependencies<never>,
    'getDb' | 'resolveSubmitTarget' | 'terminalSubscriptions'
  >
  terminal: OrchestrationMailboxTerminal
  mailboxHandle?: string
  messages: readonly OrchestrationMailboxPointerMessage[]
}): boolean {
  const { ptyId } = args.terminal
  const newestSequence = args.messages.at(-1)?.sequence
  const mailboxHandle = args.mailboxHandle ?? args.terminal.handle
  const expectedTarget = args.deps.resolveSubmitTarget(ptyId, mailboxHandle)
  const staged = args.messages[0]
  const messageIds = args.messages.map((message) => message.id)
  const phases = new Set(args.messages.map((message) => message.pointer_enter_pending))
  const persistedTarget = staged?.pointer_pty_id
    ? {
        ptyId: staged.pointer_pty_id,
        processIncarnation: staged.pointer_process_incarnation ?? ''
      }
    : null
  const bare = isTerminalMailbox(mailboxHandle)
  const subscriptionGeneration = args.deps.terminalSubscriptions?.generation(mailboxHandle)
  const hasMixedTargets = args.messages.some(
    (message) =>
      message.pointer_pty_id !== staged?.pointer_pty_id ||
      message.pointer_process_incarnation !== staged?.pointer_process_incarnation
  )
  if (
    bare &&
    (!ptyId ||
      newestSequence === undefined ||
      !expectedTarget ||
      !staged ||
      !persistedTarget ||
      hasMixedTargets)
  ) {
    args.deps.terminalSubscriptions?.record(
      mailboxHandle,
      expectedTarget ? 'ambiguous_write' : 'host_unverifiable',
      'unverifiable',
      expectedTarget ? 'persisted_target_ambiguous' : 'current_target_unverifiable',
      messageIds,
      subscriptionGeneration
    )
    return true
  }
  if (
    newestSequence === undefined ||
    !expectedTarget ||
    !staged ||
    staged.pointer_pty_id !== ptyId ||
    staged.pointer_process_incarnation !== expectedTarget.processIncarnation ||
    hasMixedTargets
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
    if (isTerminalMailbox(mailboxHandle)) {
      args.deps.terminalSubscriptions?.record(
        mailboxHandle,
        'ambiguous_write',
        'unverifiable',
        'prior_write_unverifiable',
        messageIds,
        subscriptionGeneration
      )
      return true
    }
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
