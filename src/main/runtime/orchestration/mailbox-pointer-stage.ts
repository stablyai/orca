import { isCursorAgentTitle } from '../../../shared/agent-detection'
import { formatMessagePointer } from './formatter'
import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import { isSettledWrite, type WriteSettlement } from '../../../shared/pty-write-settlement'

type StagePointerArgs<TWaiter extends OrchestrationMessageWaiter> = {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  newestSequence: number
  enterDelayMs: number
  leafKey: string
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export function stageOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>
): void {
  const ptyId = args.leaf.ptyId
  if (!ptyId) {
    return
  }
  const expectedTarget = args.deps.resolveSubmitTarget(args.leaf, ptyId)
  if (!expectedTarget) {
    return
  }
  const db = args.deps.getDb()
  const reservationTarget = {
    ptyId,
    processIncarnation: expectedTarget.processIncarnation
  }
  if (
    !db ||
    shouldReleaseOrchestrationPointer(
      db,
      args.mailboxHandle,
      args.messages,
      args.deps.getMessageWaiters(args.mailboxHandle)
    )
  ) {
    return
  }
  const flight = args.state.beginFlight(ptyId)
  flight.stagedMessageIds = args.messages.map((message) => message.id)
  try {
    if (
      !db.stageMailboxPointerEnter(flight.stagedMessageIds, reservationTarget) ||
      !db.markMailboxPointerWriteAttempted(flight.stagedMessageIds, reservationTarget)
    ) {
      args.settle(ptyId, flight)
      // Not forced: a retry would fail on the same reservation, but a park from an
      // earlier flight still has to drain.
      args.redrive(args.mailboxHandle)
      return
    }
  } catch {
    // The reservation may already be durable; recovery decides whether redrive is safe.
    args.settle(ptyId, flight)
    return
  }
  // The watermark parks concurrent deliveries, so it must never outlive the DB reservation.
  args.state.setWatermark(args.mailboxHandle, args.newestSequence, ptyId, args.leafKey)
  // Only `refused` proves no bytes left, so only `refused` may release the reservation.
  const settlePointerWrite = (settlement: WriteSettlement): void => {
    if (settlement.outcome === 'unverifiable') {
      preserveAmbiguousWrite()
      return
    }
    finishPointerWriteAndStageEnter(args, ptyId, flight, expectedTarget, settlement)
  }
  const preserveAmbiguousWrite = (): void => {
    if (!args.state.isCurrentFlight(ptyId, flight)) {
      return
    }
    args.state.deactivateWatermark(args.mailboxHandle, args.newestSequence, ptyId)
    args.settle(ptyId, flight)
  }
  try {
    const writeResult = args.deps.writePty(
      ptyId,
      formatMessagePointer(
        args.messages.length,
        args.mailboxHandle,
        args.deps.getCliCommand(expectedTarget.terminalHandle)
      )
    )
    if (isSettledWrite(writeResult)) {
      settlePointerWrite(writeResult)
      return
    }
    void writeResult.then(settlePointerWrite, preserveAmbiguousWrite).catch(() => undefined)
  } catch {
    preserveAmbiguousWrite()
  }
}

function finishPointerWriteAndStageEnter<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>,
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight,
  expectedTarget: OrchestrationMailboxPointerSubmitTarget,
  settlement: Extract<WriteSettlement, { outcome: 'accepted' | 'refused' }>
): void {
  let delayedSettle = false
  try {
    if (!args.state.isCurrentFlight(ptyId, flight)) {
      return
    }
    const db = args.deps.getDb()
    if (settlement.outcome === 'refused') {
      db?.markAsUndelivered(flight.stagedMessageIds)
      if (args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)) {
        // A delivery parked behind this watermark has to drain now that it is gone.
        args.redrive(args.mailboxHandle)
      }
      return
    }
    if (
      !db ||
      shouldReleaseOrchestrationPointer(
        db,
        args.mailboxHandle,
        args.messages,
        args.deps.getMessageWaiters(args.mailboxHandle)
      )
    ) {
      if (args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)) {
        args.redrive(args.mailboxHandle)
      }
      return
    }
    if (
      [args.leaf.lastOscTitle, args.leaf.paneTitle, args.deps.getTabTitle(args.leaf.tabId)].some(
        isCursorAgentTitle
      )
    ) {
      db.markAsDelivered(flight.stagedMessageIds)
      args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      args.redrive(args.mailboxHandle)
      return
    }
    const submitEnter = (): void =>
      submitOrchestrationMailboxPointer(
        {
          mailboxOwner: args.deps.mailboxOwner,
          state: args.state,
          getDb: args.deps.getDb,
          resolveSubmitTarget: args.deps.resolveSubmitTarget,
          getMessageWaiters: args.deps.getMessageWaiters,
          isLeafPtyProvenAbsent: args.deps.isLeafPtyProvenAbsent,
          writePty: args.deps.writePty,
          settle: args.settle,
          redrive: args.redrive
        },
        {
          leaf: args.leaf,
          mailboxHandle: args.mailboxHandle,
          messages: args.messages,
          newestSequence: args.newestSequence,
          ptyId,
          flight,
          expectedTarget
        }
      )
    flight.submitEnter = submitEnter
    const deferredEnter = flight.idleObservedWhileDeferred
      ? args.state.takeDeferredEnter(ptyId)
      : null
    if (!deferredEnter && !flight.deferredUntilIdle) {
      flight.enterTimer = setTimeout(() => {
        flight.enterTimer = null
        flight.submitEnter = null
        submitEnter()
      }, args.enterDelayMs)
    }
    delayedSettle = true
    deferredEnter?.()
  } finally {
    if (!delayedSettle) {
      args.settle(ptyId, flight)
    }
  }
}
