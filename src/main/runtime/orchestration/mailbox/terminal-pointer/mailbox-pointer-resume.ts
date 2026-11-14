import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import type { OrchestrationMailboxTerminal } from '../routing/mailbox-owner'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'

/** Classifies persisted pointer reservations against the terminal's current process; it owns no live flight. */
export function resumePendingOrchestrationMailboxPointer(args: {
  deps: Pick<PointerDeliveryDependencies<never>, 'getDb' | 'resolveSubmitTarget'>
  terminal: OrchestrationMailboxTerminal
  messages: readonly OrchestrationMailboxPointerMessage[]
}): boolean {
  const { ptyId } = args.terminal
  const expectedTarget = args.deps.resolveSubmitTarget(ptyId)
  const db = args.deps.getDb()
  if (!expectedTarget || !db) {
    return true
  }
  const byTarget = new Map<
    string,
    {
      target: { ptyId: string; processIncarnation: string }
      messages: (typeof args.messages)[number][]
    }
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
      messages: []
    }
    group.messages.push(message)
    byTarget.set(key, group)
  }
  let retained = false
  for (const group of byTarget.values()) {
    const current =
      group.target.ptyId === ptyId &&
      group.target.processIncarnation === expectedTarget.processIncarnation
    db.releaseMailboxPointerEnter(
      group.messages.map((message) => message.id),
      group.target,
      current
        ? [MAILBOX_POINTER_RESERVED]
        : [
            MAILBOX_POINTER_RESERVED,
            MAILBOX_POINTER_WRITE_ATTEMPTED,
            MAILBOX_POINTER_ENTER_ATTEMPTED
          ]
    )
    retained ||=
      current &&
      group.messages.some(
        (message) => (message.pointer_enter_pending ?? 0) > MAILBOX_POINTER_RESERVED
      )
  }
  return retained
}

export function reconcileUncertainMailboxPointers<T extends OrchestrationMessageWaiter>(
  deps: PointerDeliveryDependencies<T>,
  state: OrchestrationMailboxPointerState,
  ptyId: string
): boolean {
  try {
    const db = deps.getDb()
    const target = deps.resolveSubmitTarget(ptyId)
    if (!db || !target) {
      return false
    }
    const owned = new Set(state.flightForPty(ptyId)?.stagedMessageIds)
    const mailboxes = new Set(
      db
        .getPendingMailboxPointerMessagesForPty(ptyId)
        .filter(
          (row) =>
            (row.pointer_enter_pending ?? 0) > MAILBOX_POINTER_RESERVED &&
            row.pointer_process_incarnation === target.processIncarnation &&
            !owned.has(row.id)
        )
        .map((row) => row.to_handle)
    )
    deps.onDeliveryDecision(ptyId, { uncertainMailboxes: [...mailboxes].sort() })
    return true
  } catch {
    // Unavailable reservation evidence cannot withdraw an unread-mail explanation.
    return false
  }
}

export function reconcilePendingOrchestrationMailboxPointer<
  T extends OrchestrationMessageWaiter
>(args: {
  deps: PointerDeliveryDependencies<T>
  terminal: OrchestrationMailboxTerminal
  messages: readonly OrchestrationMailboxPointerMessage[]
  hasEligibleMail: boolean
  reconcile: () => void
  redrive: () => void
}): boolean {
  if (args.messages.length === 0) {
    return false
  }
  const retained = resumePendingOrchestrationMailboxPointer(args)
  args.reconcile()
  if (!retained && !args.hasEligibleMail) {
    args.redrive()
  }
  return retained
}

/** Reconstruct once per incarnation, then only when the uncertainty set can change. */
export class UncertainMailboxReconciliation<T extends OrchestrationMessageWaiter> {
  private readonly initialized = new Map<
    string,
    { incarnation: string; db: OrchestrationDb | null }
  >()
  private readonly pending = new Set<string>()

  constructor(
    private readonly deps: PointerDeliveryDependencies<T>,
    private readonly state: OrchestrationMailboxPointerState
  ) {}

  ensure(
    ptyId: string,
    incarnation = this.deps.resolveSubmitTarget(ptyId)?.processIncarnation
  ): void {
    const previous = this.initialized.get(ptyId)
    if (
      incarnation &&
      (previous?.incarnation !== incarnation || previous.db !== this.deps.getDb())
    ) {
      this.reconcile(ptyId)
    }
  }

  reconcile(ptyId: string): void {
    if (this.pending.has(ptyId)) {
      return
    }
    this.pending.add(ptyId)
    queueMicrotask(() => {
      if (!this.pending.delete(ptyId)) {
        return
      }
      const incarnation = this.deps.resolveSubmitTarget(ptyId)?.processIncarnation
      if (incarnation && reconcileUncertainMailboxPointers(this.deps, this.state, ptyId)) {
        this.initialized.set(ptyId, { incarnation, db: this.deps.getDb() })
      }
    })
  }

  retire(ptyId: string): void {
    this.pending.delete(ptyId)
    this.initialized.delete(ptyId)
  }
}
