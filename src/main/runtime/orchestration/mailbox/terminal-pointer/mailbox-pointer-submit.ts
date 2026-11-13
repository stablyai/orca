import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { MailboxForeground } from '../../../terminal/wait/launched-agent-foreground'
import type { MailboxDeliveryDecision } from '../notifications/mailbox-delivery-recheck'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxOwner,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

type PointerSubmitDependencies = {
  mailboxOwner: Pick<OrchestrationMailboxOwner, 'resolve'>
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ) => OrchestrationMailboxPointerSubmitTarget | null
  isAgentSettledForDelivery?: (
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ) => boolean
  readForeground: (ptyId: string) => Promise<MailboxForeground>
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  onDeliveryDecision?: (ptyId: string, decision?: MailboxDeliveryDecision) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  terminal: OrchestrationMailboxTerminal
  processIncarnation: string
}

export function resumeDeferredMailboxPointer<T extends OrchestrationMessageWaiter>(
  deps: PointerDeliveryDependencies<T>,
  state: OrchestrationMailboxPointerState,
  terminal: OrchestrationMailboxTerminal,
  coldParked: boolean
): boolean {
  const ptyId = terminal.ptyId
  if (!state.hasFlight(ptyId)) {
    return false
  }
  if (
    !state.hasActiveFlight(ptyId) &&
    (!coldParked || terminal.lastAgentStatus === 'idle') &&
    deps.isAgentSettledForDelivery(ptyId)
  ) {
    state.takeDeferredEnter(ptyId)?.()
  }
  return true
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
    stagedText?: string
    foregroundFollowup?: boolean
  }
): void {
  let clearAndRedrive = false
  let redriveClearedPointer = true
  let submitted = false
  let releaseWithoutRedrive = false
  let finalizeReservation = true
  let preserveAmbiguousDelivery = false
  let preserveFlight = false
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
      const foreground = await deps.state.foreground.probeForeground(
        input.ptyId,
        input.expectedTarget.processIncarnation,
        () => deps.readForeground(input.ptyId)
      )
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        finalizeReservation = false
        return
      }
      const target = deps.resolveSubmitTarget(input.ptyId, foreground.foreground, input.stagedText)
      const terminal =
        target?.terminal.handle === input.expectedTarget.terminal.handle &&
        target.processIncarnation === input.expectedTarget.processIncarnation
          ? target.terminal
          : null
      const sameMailbox =
        terminal && deps.mailboxOwner.resolve(terminal, input.mailboxHandle) === input.mailboxHandle
      const queueSafe = !!terminal && isMailboxTerminalTakingInput(terminal)
      const settled =
        deps.isAgentSettledForDelivery?.(input.ptyId, foreground.foreground, input.stagedText) !==
        false
      if (!terminal || !sameMailbox) {
        clearAndRedrive = true
      } else if (
        !deps.state.foreground.applyForeground(
          input.ptyId,
          foreground,
          foreground.foreground,
          queueSafe && settled && !deps.isPtyAwaitingUserInput(input.ptyId)
        )
      ) {
        if (!input.foregroundFollowup) {
          submitOrchestrationMailboxPointer(deps, { ...input, foregroundFollowup: true })
        } else {
          deps.state.deferFlightUntilIdle(input.ptyId)
          input.flight.submitEnter = () =>
            submitOrchestrationMailboxPointer(deps, { ...input, foregroundFollowup: false })
          deps.onDeliveryDecision?.(input.ptyId)
        }
        preserveFlight = true
      } else if (deps.state.foreground.foregroundHold(input.ptyId)) {
        clearAndRedrive = true
        redriveClearedPointer = false
      } else if (
        (terminal.lastAgentStatusObservedLive && terminal.lastAgentStatus === null) ||
        (queueSafe
          ? !settled
          : deps.state.foreground.screenRecovery(input.ptyId) ===
            input.expectedTarget.processIncarnation) ||
        deps.isPtyAwaitingUserInput(input.ptyId)
      ) {
        // Keep staged text pending until admission is safe; Enter could answer a dialog.
        deps.state.deferFlightUntilIdle(input.ptyId)
        input.flight.submitEnter = () => submitOrchestrationMailboxPointer(deps, input)
        deps.onDeliveryDecision?.(input.ptyId, { foreground: false })
        preserveFlight = true
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
      if (preserveFlight) {
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
