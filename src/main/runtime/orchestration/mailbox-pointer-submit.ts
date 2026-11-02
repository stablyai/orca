import type { OrchestrationDb } from './db'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxOwner,
  type OrchestrationMailboxTerminal
} from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { WriteSettlement } from '../../../shared/pty-write-settlement'

type PointerSubmitDependencies = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (ptyId: string) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  terminal: OrchestrationMailboxTerminal
  processIncarnation: string
}

export function submitOrchestrationMailboxPointer(
  deps: PointerSubmitDependencies,
  input: {
    mailboxHandle: string
    messages: readonly { id: string; type: string }[]
    newestSequence: number
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    expectedTarget: OrchestrationMailboxPointerSubmitTarget
  }
): void {
  let clearAndRedrive = false
  let redriveClearedPointer = true
  let submitted = false
  let releaseWithoutRedrive = false
  let finalizeReservation = true
  let preserveAmbiguousDelivery = false
  let deferredUntilIdle = false
  let expectedPhase = MAILBOX_POINTER_WRITE_ATTEMPTED
  const messageIds = input.messages.map((message) => message.id)
  const reservationTarget = {
    ptyId: input.ptyId,
    processIncarnation: input.expectedTarget.processIncarnation
  }
  void deps
    .isLeafPtyProvenAbsent(input.ptyId)
    .then(async (absent) => {
      if (absent) {
        clearAndRedrive = true
        return
      }
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        finalizeReservation = false
        return
      }
      const target = deps.resolveSubmitTarget(input.ptyId)
      const terminal =
        target?.terminal.handle === input.expectedTarget.terminal.handle &&
        target.processIncarnation === input.expectedTarget.processIncarnation
          ? target.terminal
          : null
      const sameMailbox =
        terminal && deps.mailboxOwner.resolve(terminal, input.mailboxHandle) === input.mailboxHandle
      const queueSafe = !!terminal && isMailboxTerminalTakingInput(terminal)
      if (!terminal || !sameMailbox) {
        clearAndRedrive = true
      } else if (
        (terminal.lastAgentStatusObservedLive && terminal.lastAgentStatus === null) ||
        deps.isPtyAwaitingUserInput(input.ptyId)
      ) {
        // A neutral title can outlive the foreground check, and an open dialog would take the
        // Enter as its answer; no Enter has been attempted yet.
        deps.state.deferFlightUntilIdle(input.ptyId)
        input.flight.submitEnter = () => submitOrchestrationMailboxPointer(deps, input)
        deferredUntilIdle = true
      } else if (!queueSafe) {
        releaseWithoutRedrive = true
      } else {
        preserveAmbiguousDelivery = true
        const db = deps.getDb()
        if (db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
          expectedPhase = MAILBOX_POINTER_ENTER_ATTEMPTED
        } else if (db?.areUnreadMessages(input.mailboxHandle, messageIds) !== false) {
          // Unread mail lost its claim to an earlier Enter or a release; read mail still gets its Enter.
          return
        }
        const enterSettlement = await deps.writePty(input.ptyId, '\r')
        submitted = enterSettlement.outcome === 'accepted'
        if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
          finalizeReservation = false
          return
        }
        // Unverifiable Enter stays attempted: neither delivery nor safe resend is proven.
        if (enterSettlement.outcome === 'refused') {
          releaseWithoutRedrive = true
        }
      }
    })
    .catch(() => {
      if (!preserveAmbiguousDelivery) {
        clearAndRedrive = true
        redriveClearedPointer = false
      }
    })
    .finally(() => {
      if (deferredUntilIdle) {
        return
      }
      let released = false
      let rollbackPersisted = true
      if (finalizeReservation) {
        if (clearAndRedrive) {
          try {
            deps.getDb()?.releaseMailboxPointerEnter(messageIds, reservationTarget, [expectedPhase])
          } catch {
            // Runtime teardown can close the DB while this delayed submit is settling.
            rollbackPersisted = false
          }
        } else if (submitted || releaseWithoutRedrive) {
          try {
            deps.getDb()?.settleMailboxPointerEnter(messageIds, reservationTarget, [expectedPhase])
          } catch {
            // A surviving pending row is revalidated against live agent state after restart.
          }
        }
        released =
          submitted || clearAndRedrive || releaseWithoutRedrive
            ? deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
            : deps.state.deactivateWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
      }
      deps.settle(input.ptyId, input.flight)
      if (
        released &&
        rollbackPersisted &&
        !releaseWithoutRedrive &&
        (!clearAndRedrive || redriveClearedPointer)
      ) {
        deps.redrive(input.mailboxHandle, clearAndRedrive)
      }
    })
}
