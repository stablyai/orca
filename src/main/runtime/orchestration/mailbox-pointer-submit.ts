import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  isTerminalMailbox,
  type TerminalMailboxSubscriptions
} from './terminal-mailbox-subscriptions'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
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
import type { WriteSettlement } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'

type PointerSubmitDependencies = {
  terminalSubscriptions?: TerminalMailboxSubscriptions
  isAgentSettledForDelivery?: (ptyId: string) => boolean
  getMessageWaiters?: (mailboxHandle: string) => ReadonlySet<OrchestrationMessageWaiter> | undefined
  mailboxOwner: Pick<OrchestrationMailboxOwner, 'resolve'>
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (
    ptyId: string,
    mailboxHandle?: string
  ) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  terminal: OrchestrationMailboxTerminal
  processIncarnation: string
  agentIdentity?: TuiAgent
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
    subscriptionGeneration?: number
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
      const target = deps.resolveSubmitTarget(input.ptyId, input.mailboxHandle)
      const terminal =
        target?.terminal.handle === input.expectedTarget.terminal.handle &&
        target.processIncarnation === input.expectedTarget.processIncarnation
          ? target.terminal
          : null
      const sameMailbox =
        terminal &&
        deps.mailboxOwner.resolve(terminal, input.mailboxHandle, { routeDirectMail: false }) ===
          input.mailboxHandle
      const queueSafe = !!terminal && isMailboxTerminalTakingInput(terminal)
      const bare = isTerminalMailbox(input.mailboxHandle)
      const subscriptionMatches =
        deps.terminalSubscriptions?.generation(input.mailboxHandle) ===
          input.subscriptionGeneration &&
        target &&
        deps.terminalSubscriptions?.matches(input.mailboxHandle, target)
      if (bare && (!terminal || !subscriptionMatches)) {
        const replacementProven =
          target &&
          (target.terminal.handle !== input.expectedTarget.terminal.handle ||
            target.terminal.ptyId !== input.expectedTarget.terminal.ptyId ||
            target.processIncarnation !== input.expectedTarget.processIncarnation ||
            target.terminal.paneKeys.length !== input.expectedTarget.terminal.paneKeys.length ||
            target.terminal.paneKeys.some(
              (key, i) => key !== input.expectedTarget.terminal.paneKeys[i]
            ))
        if (
          replacementProven ||
          deps.terminalSubscriptions?.status(input.mailboxHandle).state === 'stale_replaced'
        ) {
          clearAndRedrive = true
        } else {
          preserveAmbiguousDelivery = true
        }
      } else if (
        bare &&
        terminal &&
        (!sameMailbox ||
          terminal.lastAgentStatus !== 'idle' ||
          !terminal.lastAgentStatusObservedLive ||
          !deps.isAgentSettledForDelivery?.(input.ptyId) ||
          deps.isPtyAwaitingUserInput(input.ptyId))
      ) {
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          terminal.lastAgentStatus === 'working' ? 'blocked_working' : 'blocked_permission',
          'deferred',
          !sameMailbox ? 'mailbox_ownership_changed' : 'permission_or_prompt_changed',
          messageIds,
          input.subscriptionGeneration
        )
        releaseWithoutRedrive = true
      } else if (
        bare &&
        target &&
        (target.agentIdentity === undefined ||
          target.agentIdentity === 'cursor' ||
          target.agentIdentity !== input.expectedTarget.agentIdentity)
      ) {
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          'active',
          'deferred',
          'manual_submit_required',
          messageIds,
          input.subscriptionGeneration
        )
        releaseWithoutRedrive = true
      } else if (!terminal || !sameMailbox) {
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
      } else if (
        bare &&
        shouldReleaseOrchestrationPointer(
          deps.getDb(),
          input.mailboxHandle,
          input.messages,
          deps.getMessageWaiters?.(input.mailboxHandle)
        )
      ) {
        releaseWithoutRedrive = true
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
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          enterSettlement.outcome === 'unverifiable' ? 'ambiguous_write' : 'active',
          submitted
            ? 'submitted'
            : enterSettlement.outcome === 'refused'
              ? 'deferred'
              : 'unverifiable',
          `enter_${enterSettlement.outcome}`,
          messageIds,
          input.subscriptionGeneration
        )
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
      deps.terminalSubscriptions?.record(
        input.mailboxHandle,
        'ambiguous_write',
        'unverifiable',
        'submit_unverifiable',
        messageIds,
        input.subscriptionGeneration
      )
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
