import {
  isTerminalMailbox,
  type TerminalMailboxSubscriptions
} from './terminal-mailbox-subscriptions'
import type { OrchestrationDb } from './db'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { WriteSettlement } from '../../../shared/pty-write-settlement'
import type { TuiAgent } from '../../../shared/tui-agent'

type PointerSubmitDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  terminalSubscriptions?: TerminalMailboxSubscriptions
  isAgentSettledForDelivery?: (leaf: OrchestrationMailboxLeaf) => boolean
  mailboxOwner: Pick<OrchestrationMailboxOwner, 'resolve'>
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (
    leaf: OrchestrationMailboxLeaf,
    ptyId: string
  ) => OrchestrationMailboxPointerSubmitTarget | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  writePty: (ptyId: string, data: string) => WriteSettlement | Promise<WriteSettlement>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  leaf: OrchestrationMailboxLeaf
  terminalHandle: string
  processIncarnation: string
  agentIdentity?: TuiAgent
}

export function submitOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: PointerSubmitDependencies<TWaiter>,
  input: {
    leaf: OrchestrationMailboxLeaf
    mailboxHandle: string
    messages: readonly { id: string; type: string }[]
    newestSequence: number
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    subscriptionGeneration?: number
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
      const target = deps.resolveSubmitTarget(input.leaf, input.ptyId)
      const exactTarget =
        target?.terminalHandle === input.expectedTarget.terminalHandle &&
        target.processIncarnation === input.expectedTarget.processIncarnation
          ? target
          : null
      const sameMailbox =
        exactTarget &&
        deps.mailboxOwner.resolve(exactTarget.leaf, undefined, {
          terminalHandle: exactTarget.terminalHandle
        }) === input.mailboxHandle
      const queueSafe =
        exactTarget?.leaf.lastAgentStatusObservedLive === true &&
        (exactTarget.leaf.lastAgentStatus === 'idle' ||
          exactTarget.leaf.lastAgentStatus === 'working')
      const bare = isTerminalMailbox(input.mailboxHandle)
      const subscriptionGenerationMatches =
        deps.terminalSubscriptions?.generation(input.mailboxHandle) === input.subscriptionGeneration
      const subscriptionMatches = Boolean(
        exactTarget && deps.terminalSubscriptions?.matches(input.mailboxHandle, exactTarget)
      )
      if (bare && (!subscriptionGenerationMatches || !exactTarget || !subscriptionMatches)) {
        const replacementProven = Boolean(
          target &&
          (target.terminalHandle !== input.expectedTarget.terminalHandle ||
            target.leaf.ptyId !== input.expectedTarget.leaf.ptyId ||
            target.processIncarnation !== input.expectedTarget.processIncarnation ||
            target.leaf.tabId !== input.expectedTarget.leaf.tabId ||
            target.leaf.leafId !== input.expectedTarget.leaf.leafId)
        )
        if (
          replacementProven ||
          deps.terminalSubscriptions?.status(input.mailboxHandle).state === 'stale_replaced'
        ) {
          clearAndRedrive = true
        } else {
          preserveAmbiguousDelivery = true
        }
      } else if (bare && exactTarget && !sameMailbox) {
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          'blocked_permission',
          'deferred',
          'mailbox_ownership_changed',
          messageIds,
          input.subscriptionGeneration
        )
        releaseWithoutRedrive = true
      } else if (bare && exactTarget && !exactTarget.leaf.writable) {
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          'host_unverifiable',
          'unverifiable',
          'pty_not_writable_before_enter',
          messageIds,
          input.subscriptionGeneration
        )
        releaseWithoutRedrive = true
      } else if (
        bare &&
        exactTarget &&
        (exactTarget.leaf.lastAgentStatus !== 'idle' ||
          !exactTarget.leaf.lastAgentStatusObservedLive ||
          !deps.isAgentSettledForDelivery?.(exactTarget.leaf))
      ) {
        const blockedWorking = exactTarget.leaf.lastAgentStatus === 'working'
        deps.terminalSubscriptions?.record(
          input.mailboxHandle,
          blockedWorking ? 'blocked_working' : 'blocked_permission',
          'deferred',
          blockedWorking ? 'working_before_enter' : 'permission_or_prompt_changed',
          messageIds,
          input.subscriptionGeneration
        )
        releaseWithoutRedrive = true
      } else if (
        bare &&
        exactTarget &&
        (exactTarget.agentIdentity === undefined ||
          exactTarget.agentIdentity === 'cursor' ||
          exactTarget.agentIdentity !== input.expectedTarget.agentIdentity)
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
      } else if (!exactTarget?.leaf.writable || !sameMailbox) {
        clearAndRedrive = true
      } else if (
        exactTarget.leaf.lastAgentStatusObservedLive &&
        exactTarget.leaf.lastAgentStatus === null
      ) {
        // A neutral title can outlive the foreground check; no Enter has been attempted yet.
        deps.state.deferFlightUntilIdle(input.ptyId)
        input.flight.submitEnter = () => submitOrchestrationMailboxPointer(deps, input)
        deferredUntilIdle = true
      } else if (!queueSafe) {
        releaseWithoutRedrive = true
      } else {
        if (
          shouldReleaseOrchestrationPointer(
            deps.getDb(),
            input.mailboxHandle,
            input.messages,
            deps.getMessageWaiters(input.mailboxHandle)
          )
        ) {
          releaseWithoutRedrive = true
        } else {
          preserveAmbiguousDelivery = true
          const db = deps.getDb()
          if (!db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
            return
          }
          expectedPhase = MAILBOX_POINTER_ENTER_ATTEMPTED
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
          // An unverifiable Enter stays at ENTER_ATTEMPTED: neither settling it as delivered
          // nor rolling it back to a state that would send a second Enter is provable here.
          if (enterSettlement.outcome === 'refused') {
            releaseWithoutRedrive = true
          }
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
