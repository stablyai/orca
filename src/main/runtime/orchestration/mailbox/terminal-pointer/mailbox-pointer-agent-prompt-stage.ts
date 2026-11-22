import { formatMessagePointer } from '../formatting/message-formatting'
import { isMailboxTerminalTakingInput } from '../routing/mailbox-owner'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { StagePointerArgs } from './mailbox-pointer-stage'
import type { OrchestrationMailboxDeliveryFlight } from './mailbox-pointer-state'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import { MAILBOX_POINTER_ENTER_ATTEMPTED } from '../../db/messages/mailbox-pointer-enter-state'

export function stageMailboxPointerAgentPrompt<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>,
  flight: OrchestrationMailboxDeliveryFlight,
  target: OrchestrationMailboxPointerSubmitTarget
): void {
  const { ptyId } = target.terminal
  const reservation = { ptyId, processIncarnation: target.processIncarnation }
  const assertCurrent = (): void => {
    const current = args.deps.resolveSubmitTarget(ptyId)
    if (
      !args.state.isCurrentFlight(ptyId, flight) ||
      current?.processIncarnation !== target.processIncarnation ||
      current.agent !== 'codex' ||
      current.terminal.handle !== target.terminal.handle ||
      !isMailboxTerminalTakingInput(current.terminal) ||
      args.deps.isPtyAwaitingUserInput(ptyId) ||
      args.deps.mailboxOwner.resolve(current.terminal, args.mailboxHandle) !== args.mailboxHandle
    ) {
      throw new Error('mailbox_pointer_target_changed')
    }
  }
  void args.deps
    .sendAgentPrompt({
      target,
      requestId: `mailbox-pointer:${flight.stagedMessageIds.join(',')}`,
      prompt: formatMessagePointer(
        args.messages.length,
        args.mailboxHandle,
        args.deps.getCliCommand(target.terminal.handle),
        args.heldDeliveryId,
        target.terminal.handle
      ).trim(),
      assertCurrent,
      beforeSubmit: () => {
        const db = args.deps.getDb()
        if (
          !db?.markMailboxPointerEnterAttempted(flight.stagedMessageIds, reservation) &&
          db?.areUnreadMessages(args.mailboxHandle, flight.stagedMessageIds) !== false
        ) {
          throw new Error('mailbox_pointer_reservation_changed')
        }
      }
    })
    .then((result) => {
      if (!args.state.isCurrentFlight(ptyId, flight)) {
        return
      }
      if (result === 'submitted') {
        args.deps
          .getDb()
          ?.settleMailboxPointerEnter(
            flight.stagedMessageIds,
            reservation,
            [MAILBOX_POINTER_ENTER_ATTEMPTED],
            { kind: 'terminal', handle: target.terminal.handle }
          )
        args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      } else if (result === 'refused') {
        args.deps.getDb()?.markAsUndelivered(flight.stagedMessageIds)
        args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      } else {
        args.state.deactivateWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      }
    })
    .catch(() => {
      // A lost receipt or closed database cannot authorize a second paste.
      if (args.state.isCurrentFlight(ptyId, flight)) {
        args.state.deactivateWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      }
    })
    .finally(() => args.settle(ptyId, flight))
}
