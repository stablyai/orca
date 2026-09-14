import {
  recordHiddenRendererPtyDataDrop,
  shouldDropHiddenRendererPtyData
} from '../../pty-hidden-delivery-gate'
import { propagatePendingProjectionRemainder } from '../../pty-pending-projection-admissions'
import type { PendingPtyData } from '../../pty-pending-data-drain-queue'
import { activeRendererPtys } from './visibility-state'
import {
  PTY_BATCH_DRAIN_CONTINUE_MS,
  PTY_BATCH_FLUSH_CHUNK_CHARS,
  PTY_BATCH_FLUSH_MAX_WRITES,
  PTY_DISPATCHER_READY_WATCHDOG_MS
} from './constants'
import {
  getDroppedMode2031RendererData,
  pendingProjectionAdmissionOptions,
  updatePendingProjectionAdmissions
} from './pending'
import { makePtyDataPayload, sendModelRestoreNeededMarker, sendPtyDataToRenderer } from './payload'
import { warnIfDroppingHiddenBytesForVisiblePty } from './debug-snapshot'
import type { PtyIpcSession } from '../session'

export function schedulePendingDataFlush(session: PtyIpcSession, delayMs: number): void {
  if (session.flushTimer) {
    return
  }
  session.flushTimer = setTimeout(() => session.flushPendingData(), delayMs)
}

export function invalidatePendingPtyDrainClassification(
  session: PtyIpcSession,
  id?: string,
  schedule = true
): void {
  const invalidated =
    typeof id === 'string'
      ? session.pendingData.invalidate(id)
      : session.pendingData.invalidateAll()
  if (invalidated && schedule && !session.flushTimer) {
    schedulePendingDataFlush(session, 0)
  }
}

export function clearDispatcherReadyWatchdog(session: PtyIpcSession): void {
  if (session.dispatcherReadyWatchdogTimer) {
    clearTimeout(session.dispatcherReadyWatchdogTimer)
    session.dispatcherReadyWatchdogTimer = null
  }
}

export function armDispatcherReadyWatchdog(session: PtyIpcSession): void {
  clearDispatcherReadyWatchdog(session)
  if (session.mainWindow.isDestroyed()) {
    return
  }
  // Why: one-shot self-heal — force the gate open if the reloaded page never signals ready, so a dropped handshake can't hold it forever. Unref'd so it can't keep the process alive.
  session.dispatcherReadyWatchdogTimer = setTimeout(() => {
    session.dispatcherReadyWatchdogTimer = null
    if (session.rendererPtyDispatcherReady || session.mainWindow.isDestroyed()) {
      return
    }
    session.rendererPtyDispatcherReady = true
    session.rendererDispatcherReadyForcedCount += 1
    session.pendingData.reactivateBlocked()
    schedulePendingDataFlush(session, 0)
  }, PTY_DISPATCHER_READY_WATCHDOG_MS)
  session.dispatcherReadyWatchdogTimer.unref?.()
}

export function clearFlushTimerIfIdle(session: PtyIpcSession): void {
  if (session.pendingData.size > 0 || session.flushTimer === null) {
    return
  }
  clearTimeout(session.flushTimer)
  session.flushTimer = null
}

export function flushPendingData(session: PtyIpcSession): void {
  session.flushTimer = null
  if (session.mainWindow.isDestroyed()) {
    // Why release now: bookkeeping is being wiped, so no future drain can resume these producers — local shells would wedge.
    session.producerFlowControl.releaseAll()
    session.clearDeliveryResyncProbe()
    session.clearPendingPtyData()
    session.pendingOverflowMarkedPtys.clear()
    session.rendererDeliveryAccountingByPty.clear()
    session.rendererInFlightTotalChars = 0
    session.clearDispatcherReadyWatchdog()
    return
  }
  // Ordinary boot-window data is blocked in the queue; hidden-droppable entries still retire before renderer readiness.
  const settings = session.getSettings?.()
  let writes = 0
  let sendFailed = false
  const round = session.pendingData.beginRound()
  let creditReleasedDuringFlush = false
  session.pendingDataFlushActive = true
  session.pendingDataCreditReleasedDuringFlush = false
  try {
    while (writes < PTY_BATCH_FLUSH_MAX_WRITES) {
      const selection = session.pendingData.takeNext(round)
      if (!selection) {
        break
      }
      const { id, pending } = selection
      // Why drop, never re-queue: the model already ingested hidden-gated bytes; reveal restores from the snapshot+seq machinery.
      if (shouldDropHiddenRendererPtyData(id, settings)) {
        session.pendingData.remove(selection)
        session.pendingOverflowMarkedPtys.delete(id)
        session.updateProducerFlowControl(id)
        const drop = recordHiddenRendererPtyDataDrop(id, pending.data.length)
        if (pending.projectionAdmissionIds) {
          session.sshOutputIntake?.transferProjections(
            pending.projectionAdmissionIds,
            'hidden-drop'
          )
        }
        warnIfDroppingHiddenBytesForVisiblePty(session, id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(
            session,
            id,
            'hidden-drop',
            session.runtime?.getPtyOutputSequence(id)
          )
        }
        continue
      }
      if (!session.canSendPtyDataToRenderer(id, { interactive: activeRendererPtys.has(id) })) {
        session.pendingData.block(selection)
        continue
      }
      if (pending.droppedOutput === true) {
        session.pendingData.remove(selection)
        session.updateProducerFlowControl(id)
        // Why droppedOutput sentinel: pending-cap drop means the pane must repaint from the snapshot, not continue a gapped stream (data = carved query bytes only).
        if (
          !sendPtyDataToRenderer(
            session,
            id,
            {
              id,
              data: pending.data + getDroppedMode2031RendererData(pending),
              droppedOutput: true
            },
            pending.projectionAdmissionIds
          ).sent
        ) {
          sendFailed = true
          break
        }
        writes++
        continue
      }
      const { data } = pending
      const indivisible = pending.transformed === true
      const chunk = indivisible ? data : data.slice(0, PTY_BATCH_FLUSH_CHUNK_CHARS)
      const remaining = indivisible ? '' : data.slice(PTY_BATCH_FLUSH_CHUNK_CHARS)
      let nextPending: PendingPtyData | undefined
      if (remaining) {
        nextPending = { data: remaining }
        if (typeof pending.startSeq === 'number') {
          nextPending.startSeq = pending.startSeq + chunk.length
        }
        if (pending.containsBackgroundOutput === true) {
          nextPending.containsBackgroundOutput = true
        }
        if (pending.projectionAdmissionIds) {
          nextPending.projectionAdmissionIds = pending.projectionAdmissionIds
        }
        if (pending.projectionAdmissionsTransferred) {
          nextPending.projectionAdmissionsTransferred = true
        }
        session.pendingData.replaceWithRemainder(selection, nextPending)
      } else {
        session.pendingData.remove(selection)
        session.pendingOverflowMarkedPtys.delete(id)
      }
      session.updateProducerFlowControl(id)
      const delivery = sendPtyDataToRenderer(
        session,
        id,
        makePtyDataPayload(
          id,
          chunk,
          pending.startSeq,
          pending.containsBackgroundOutput,
          pending.rawLength,
          pending.transformed
        ),
        pending.projectionAdmissionIds
      )
      if (nextPending) {
        updatePendingProjectionAdmissions(
          nextPending,
          propagatePendingProjectionRemainder(
            nextPending,
            delivery,
            pendingProjectionAdmissionOptions(session)
          )
        )
      }
      if (!delivery.sent) {
        sendFailed = true
        break
      }
      writes++
    }
  } finally {
    session.pendingDataFlushActive = false
    creditReleasedDuringFlush = session.pendingDataCreditReleasedDuringFlush
    session.pendingDataCreditReleasedDuringFlush = false
    session.pendingData.endRound(round)
  }
  if (
    session.rendererPtyDispatcherReady &&
    session.pendingData.size > 0 &&
    writes === 0 &&
    !sendFailed
  ) {
    session.ackGatedFlushSkipCount++
  }
  if (sendFailed && session.pendingData.size > 0) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    schedulePendingDataFlush(session, PTY_BATCH_DRAIN_CONTINUE_MS)
    return
  }
  if (session.pendingData.size > 0 && (writes > 0 || creditReleasedDuringFlush)) {
    // Why yield between slices: a background terminal can dump megabytes at once, and keystroke writes must not stall behind one flush.
    schedulePendingDataFlush(session, writes > 0 ? PTY_BATCH_DRAIN_CONTINUE_MS : 0)
  }
}
