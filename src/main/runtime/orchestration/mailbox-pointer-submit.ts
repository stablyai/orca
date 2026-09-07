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

type PointerSubmitDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
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
    expectedTarget: OrchestrationMailboxPointerSubmitTarget
  }
): void {
  let clearAndRedrive = false
  let redriveClearedPointer = true
  let submitted = false
  let releaseWithoutRedrive = false
  let finalizeReservation = true
  let preserveAmbiguousDelivery = false
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
      if (!exactTarget?.leaf.writable || !sameMailbox) {
        clearAndRedrive = true
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
      if (!preserveAmbiguousDelivery) {
        clearAndRedrive = true
        redriveClearedPointer = false
      }
    })
    .finally(() => {
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
