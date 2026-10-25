import {
  recordHiddenRendererPtyDataDrop,
  shouldDropHiddenRendererPtyData
} from './pty-hidden-delivery-gate'
import type { PendingPtyData } from './pty-pending-data-drain-contract'
import { activeRendererPtys } from './visibility-state'
import {
  PTY_BATCH_DRAIN_CONTINUE_MS,
  PTY_BATCH_FLUSH_CHUNK_CHARS,
  PTY_BATCH_FLUSH_MAX_WRITES,
  PTY_DISPATCHER_READY_WATCHDOG_MS
} from './constants'
import { getDroppedMode2031RendererData, getDroppedSynchronizedOutputRendererData } from './pending'
import { resolveSynchronizedOutputSafeSplit } from '../../../../shared/terminal-synchronized-output-scan'
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
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
    return
  }
  // A lost readiness handshake must not hold output forever; unref the recovery watchdog.
  session.dispatcherReadyWatchdogTimer = setTimeout(() => {
    session.dispatcherReadyWatchdogTimer = null
    if (
      session.rendererPtyDispatcherReady ||
      !session.mainWindow ||
      session.mainWindow.isDestroyed()
    ) {
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
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
    // Resume before wiping bookkeeping; no later drain can release these producers.
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
      // The model already owns hidden bytes; discard delivery and restore from its snapshot on reveal.
      if (shouldDropHiddenRendererPtyData(id, settings)) {
        session.pendingData.remove(selection)
        session.pendingOverflowMarkedPtys.delete(id)
        session.updateProducerFlowControl(id)
        const drop = recordHiddenRendererPtyDataDrop(id, pending.data.length)
        warnIfDroppingHiddenBytesForVisiblePty(session, id, pending.data.length)
        if (drop.shouldEmitRestoreMarker) {
          sendModelRestoreNeededMarker(
            session,
            id,
            'hidden-drop',
            session.runtime?.getPtyOutputSequence(id),
            drop.hiddenDropEpisode
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
        // A pending-cap gap requires snapshot repaint; only salvaged query bytes remain in data.
        if (
          !sendPtyDataToRenderer(session, id, {
            id,
            // Release DEC 2026 before salvaged partial mode-2031 CSI so a later ESC cannot abort it.
            data:
              pending.data +
              getDroppedSynchronizedOutputRendererData(pending) +
              getDroppedMode2031RendererData(pending),
            droppedOutput: true
          })
        ) {
          sendFailed = true
          break
        }
        writes++
        continue
      }
      const { data } = pending
      const indivisible = pending.transformed === true
      // Keep synchronized frames intact or xterm holds painting until the closing escape or its timeout.
      const splitAt = indivisible
        ? data.length
        : resolveSynchronizedOutputSafeSplit(data, PTY_BATCH_FLUSH_CHUNK_CHARS)
      const chunk = indivisible ? data : data.slice(0, splitAt)
      const remaining = indivisible ? '' : data.slice(splitAt)
      if (remaining) {
        const nextPending: PendingPtyData = { data: remaining }
        if (typeof pending.startSeq === 'number') {
          nextPending.startSeq = pending.startSeq + chunk.length
        }
        if (pending.containsBackgroundOutput === true) {
          nextPending.containsBackgroundOutput = true
        }
        session.pendingData.replaceWithRemainder(selection, nextPending)
      } else {
        session.pendingData.remove(selection)
        session.pendingOverflowMarkedPtys.delete(id)
      }
      session.updateProducerFlowControl(id)
      const sent = sendPtyDataToRenderer(
        session,
        id,
        makePtyDataPayload(
          id,
          chunk,
          pending.startSeq,
          pending.containsBackgroundOutput,
          pending.rawLength,
          pending.transformed
        )
      )
      if (!sent) {
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
    // Yield between slices so background floods do not delay keystroke writes.
    schedulePendingDataFlush(session, writes > 0 ? PTY_BATCH_DRAIN_CONTINUE_MS : 0)
  }
}
