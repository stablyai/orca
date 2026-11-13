import { terminalComposerTextOwnsPointer } from '../../../terminal/wait/terminal-delivery-refusal'
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

export type PointerSubmitDependencies = {
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
  readComposerText?: (ptyId: string) => string | null
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
    (state.foreground.screenRecovery(ptyId) === state.flightForPty(ptyId)?.processIncarnation ||
      ((!coldParked || terminal.lastAgentStatus === 'idle') &&
        deps.isAgentSettledForDelivery(ptyId)))
  ) {
    state.takeDeferredEnter(ptyId)?.()
  }
  return true
}

export type PointerSubmitInput = {
  mailboxHandle: string
  messages: readonly { id: string; type: string }[]
  newestSequence: number
  ptyId: string
  flight: OrchestrationMailboxDeliveryFlight
  expectedTarget: OrchestrationMailboxPointerSubmitTarget
  stagedText?: string
  enterUncertain?: boolean
}

export function submitOrchestrationMailboxPointer(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput
): void {
  let clearAndRedrive = false
  let redriveClearedPointer = true
  let submitted = false
  let releaseWithoutRedrive = false
  let finalizeReservation = true
  let preserveAmbiguousDelivery = input.enterUncertain === true
  let preserveFlight = false
  let expectedPhase = MAILBOX_POINTER_WRITE_ATTEMPTED
  const isRecovering = () =>
    deps.state.foreground.screenRecovery(input.ptyId) === input.expectedTarget.processIncarnation
  const messageIds = input.messages.map((message) => message.id)
  const reservationTarget = {
    ptyId: input.ptyId,
    processIncarnation: input.expectedTarget.processIncarnation
  }
  void deps
    .isLeafPtyProvenAbsent(input.ptyId)
    .then(async (absent) => {
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        finalizeReservation = false
        return
      }
      if (absent) {
        clearAndRedrive = true
        return
      }
      if (input.enterUncertain) {
        if (messageIds.every((id) => deps.getDb()?.getMessageById(id)?.read === 1)) {
          clearAndRedrive = true
        } else {
          preserveAmbiguousDelivery = true
          preserveFlight = true
        }
        return
      }
      const composerBeforeProbe = deps.readComposerText?.(input.ptyId)
      if (
        isRecovering() &&
        !terminalComposerTextOwnsPointer(composerBeforeProbe, input.stagedText) &&
        deps.getDb()?.areUnreadMessages(input.mailboxHandle, messageIds) === false &&
        messageIds.every((id) => deps.getDb()?.getMessageById(id)?.read === 1)
      ) {
        clearAndRedrive = true
        return
      }
      if (isRecovering() && deps.isAgentSettledForDelivery?.(input.ptyId) === false) {
        preserveFlight = true
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
      const target = deps.resolveSubmitTarget(
        input.ptyId,
        isRecovering() && foreground.foreground !== 'agent' ? undefined : foreground.foreground,
        input.stagedText
      )
      const terminal =
        target?.terminal.handle === input.expectedTarget.terminal.handle &&
        target.processIncarnation === input.expectedTarget.processIncarnation
          ? target.terminal
          : null
      const sameMailbox =
        terminal && deps.mailboxOwner.resolve(terminal, input.mailboxHandle) === input.mailboxHandle
      if (!terminal || !sameMailbox) {
        clearAndRedrive = true
        return
      }
      if (isRecovering() && foreground.foreground !== 'agent') {
        deps.state.foreground.applyForeground(input.ptyId, foreground, foreground.foreground)
        preserveFlight = true
        return
      }
      const queueSafe = !!terminal && isMailboxTerminalTakingInput(terminal)
      const settled =
        deps.isAgentSettledForDelivery?.(input.ptyId, foreground.foreground, input.stagedText) !==
        false
      const composer = deps.readComposerText?.(input.ptyId)
      const ownPointer = terminalComposerTextOwnsPointer(composer, input.stagedText)
      if (
        !deps.state.foreground.applyForeground(
          input.ptyId,
          foreground,
          foreground.foreground,
          queueSafe && settled && !deps.isPtyAwaitingUserInput(input.ptyId)
        )
      ) {
        preserveFlight = true
      } else if (
        isRecovering() &&
        (foreground.foreground !== 'agent' ||
          !terminal.lastAgentStatusObservedLive ||
          !settled ||
          !ownPointer)
      ) {
        // Missing text cannot distinguish deletion from a user-submitted pointer.
        preserveFlight = true
      } else if (deps.state.foreground.foregroundHold(input.ptyId)) {
        preserveFlight = true
      } else if (
        (!isRecovering() &&
          terminal.lastAgentStatusObservedLive &&
          terminal.lastAgentStatus === null) ||
        (queueSafe && !settled) ||
        deps.isPtyAwaitingUserInput(input.ptyId)
      ) {
        preserveFlight = true
      } else if (!queueSafe) {
        releaseWithoutRedrive = true
      } else {
        preserveAmbiguousDelivery = true
        const db = deps.getDb()
        if (db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
          expectedPhase = MAILBOX_POINTER_ENTER_ATTEMPTED
        } else if (db?.areUnreadMessages(input.mailboxHandle, messageIds) !== false) {
          // A prior attempted Enter cannot authorize replay; read mail still gets its Enter.
          preserveFlight = isRecovering()
          return
        }
        const enterSettlement = await deps.writePty(input.ptyId, '\r')
        submitted = enterSettlement.outcome === 'accepted'
        if (isRecovering() && enterSettlement.outcome === 'unverifiable') {
          preserveFlight = true
        }
        if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
          finalizeReservation = false
          return
        }
        // Unverifiable Enter stays attempted: neither delivery nor safe resend is proven.
        if (enterSettlement.outcome === 'refused') {
          if (isRecovering()) {
            preserveAmbiguousDelivery = false
            preserveFlight = true
            if (
              expectedPhase === MAILBOX_POINTER_ENTER_ATTEMPTED &&
              db?.markMailboxPointerWriteAttempted(messageIds, reservationTarget, expectedPhase)
            ) {
              expectedPhase = MAILBOX_POINTER_WRITE_ATTEMPTED
            }
          } else {
            releaseWithoutRedrive = true
          }
        }
      }
    })
    .catch(() => {
      if (deps.state.isCurrentFlight(input.ptyId, input.flight) && isRecovering()) {
        preserveFlight = true
      } else if (!preserveAmbiguousDelivery) {
        clearAndRedrive = true
        redriveClearedPointer = false
      }
    })
    .finally(() => {
      if (preserveFlight && deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        deps.state.deferFlightUntilIdle(input.ptyId)
        input.flight.submitEnter = () =>
          submitOrchestrationMailboxPointer(deps, {
            ...input,
            enterUncertain: preserveAmbiguousDelivery
          })
        deps.onDeliveryDecision?.(input.ptyId, isRecovering() ? undefined : { foreground: false })
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
