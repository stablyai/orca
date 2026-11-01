import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import { finishPointerWriteAndStageEnter } from './mailbox-pointer-stage'
import { formatMessagePointer } from './formatter'
import { isHeldAgentPromptDraft } from '../../../shared/agent-prompt-injection'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'

const COMPOSER_DRAFT_READ_TIMEOUT_MS = 2_000

type ResumePointerArgs<TWaiter extends OrchestrationMessageWaiter> = {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  terminal: OrchestrationMailboxTerminal
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

/** Classifies persisted pointer reservations against the terminal's current process; only a
 *  pointer left typed without Enter gets a live flight. */
export function resumePendingOrchestrationMailboxPointer<
  TWaiter extends OrchestrationMessageWaiter
>(args: ResumePointerArgs<TWaiter>): boolean {
  const { ptyId } = args.terminal
  const newestSequence = args.messages.at(-1)?.sequence
  const expectedTarget = args.deps.resolveSubmitTarget(ptyId)
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
  if (phases.size === 1 && phases.has(MAILBOX_POINTER_WRITE_ATTEMPTED)) {
    // No Enter was attempted, so a crash after the text landed leaves it typed in the composer.
    submitPointerLeftInComposer(args, expectedTarget, newestSequence)
    return true
  }
  if (phases.size !== 1 || !phases.has(MAILBOX_POINTER_RESERVED)) {
    // An attempted Enter may have landed, so neither a retype nor another Enter is safe.
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

/** Enter only a composer holding exactly this pointer; anything else keeps the old settle, since
 *  retyping could double the line and Enter could submit the user's own text. */
function submitPointerLeftInComposer<TWaiter extends OrchestrationMessageWaiter>(
  args: ResumePointerArgs<TWaiter>,
  expectedTarget: OrchestrationMailboxPointerSubmitTarget,
  newestSequence: number
): void {
  const { ptyId } = args.terminal
  const target = { ptyId, processIncarnation: expectedTarget.processIncarnation }
  const messageIds = args.messages.map((message) => message.id)
  const flight = args.state.beginFlight(ptyId)
  flight.processIncarnation = target.processIncarnation
  flight.stagedMessageIds = messageIds
  args.state.setWatermark(args.mailboxHandle, newestSequence, ptyId)
  const cliCommand = args.deps.getCliCommand(expectedTarget.terminal.handle)
  const heldDeliveryId = args.deps.getDb()?.getOutstandingMailboxDelivery?.(args.mailboxHandle)?.id
  const pointers = [undefined, heldDeliveryId].map((held) =>
    formatMessagePointer(args.messages.length, args.mailboxHandle, cliCommand, held)
  )
  // The flight holds this terminal's other mail, so a stalled screen read must not hold it long.
  void withTimeout(args.deps.readComposerDraft(ptyId), COMPOSER_DRAFT_READ_TIMEOUT_MS, undefined)
    .then((draft) => {
      if (!args.state.isCurrentFlight(ptyId, flight)) {
        return
      }
      if (pointers.some((pointer) => isHeldAgentPromptDraft(draft, pointer, 0))) {
        // Resume as if the write just settled; the text has waited long enough for its Enter.
        finishPointerWriteAndStageEnter(
          { ...args, newestSequence, enterDelayMs: 0 },
          ptyId,
          flight,
          expectedTarget,
          { outcome: 'accepted' }
        )
        return
      }
      try {
        args.deps
          .getDb()
          ?.settleMailboxPointerEnter(messageIds, target, [MAILBOX_POINTER_WRITE_ATTEMPTED])
      } catch {
        // Runtime teardown can close the DB while the screen read is in flight.
      }
      const released = args.state.clearWatermark(args.mailboxHandle, newestSequence, ptyId)
      args.settle(ptyId, flight)
      if (released) {
        args.redrive(args.mailboxHandle)
      }
    })
    .catch(() => undefined)
}
