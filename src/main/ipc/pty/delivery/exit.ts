import {
  interactiveOutputCharsByPty,
  lastInputAtByPty,
  SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS
} from './visibility-state'
import { allocatePtyLifecycleSequence } from '../host-env/types'
import { makePtyDataPayload, sendPtyDataToRenderer } from './payload'
import { getRendererInFlightCharsForPty } from './accounting'
import { clearFlushTimerIfIdle } from './flush'
import { ptyIncarnationById } from '../provider/ownership-state'
import type { PtyIpcSession } from '../session'

export type ReplacedPtyStop = {
  incarnationId: string | undefined
  expiryTimer?: NodeJS.Timeout
}

/** Labels the exit of a PTY that main stops so a new process can take its pane. Settle with
 *  whether the stop succeeded; a failed stop leaves no label behind. */
export function markReplacedPtyStop(
  session: PtyIpcSession,
  id: string
): (stopped: boolean) => void {
  clearTimeout(session.replacedPtyStopsById.get(id)?.expiryTimer)
  const mark: ReplacedPtyStop = { incarnationId: ptyIncarnationById.get(id) }
  session.replacedPtyStopsById.set(id, mark)
  return (stopped) => {
    if (session.replacedPtyStopsById.get(id) !== mark) {
      return
    }
    if (!stopped) {
      session.replacedPtyStopsById.delete(id)
      return
    }
    // Why a window: an SSH exit can reach the renderer after the stop settles; bound it like a synthetic kill.
    mark.expiryTimer = setTimeout(() => {
      if (session.replacedPtyStopsById.get(id) === mark) {
        session.replacedPtyStopsById.delete(id)
      }
    }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
    mark.expiryTimer.unref?.()
  }
}

function consumeReplacedPtyStop(
  session: PtyIpcSession,
  payload: { id: string; incarnationId?: string }
): boolean {
  const mark = session.replacedPtyStopsById.get(payload.id)
  if (
    !mark ||
    (mark.incarnationId && payload.incarnationId && mark.incarnationId !== payload.incarnationId)
  ) {
    return false
  }
  clearTimeout(mark.expiryTimer)
  session.replacedPtyStopsById.delete(payload.id)
  return true
}

export function rememberSyntheticKillExit(
  session: PtyIpcSession,
  id: string,
  incarnationId?: string
): void {
  const existing = session.syntheticKillExitPtyIds.get(id)
  if (existing) {
    clearTimeout(existing.cleanupTimer)
  }
  // Only the same incarnation's late exit duplicates the synthetic renderer notification.
  const cleanupTimer = setTimeout(() => {
    session.syntheticKillExitPtyIds.delete(id)
  }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
  cleanupTimer.unref?.()
  session.syntheticKillExitPtyIds.set(id, { cleanupTimer, incarnationId })
}

export function rememberRetiredRejectedPty(session: PtyIpcSession, id: string): void {
  const existing = session.retiredRejectedPtyIds.get(id)
  if (existing) {
    clearTimeout(existing)
  }
  const cleanupTimer = setTimeout(() => {
    session.retiredRejectedPtyIds.delete(id)
  }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
  cleanupTimer.unref?.()
  session.retiredRejectedPtyIds.set(id, cleanupTimer)
}

export function consumeSyntheticKillExit(
  session: PtyIpcSession,
  id: string,
  incarnationId?: string
): boolean {
  const pending = session.syntheticKillExitPtyIds.get(id)
  if (!pending || pending.incarnationId !== incarnationId) {
    return false
  }
  clearTimeout(pending.cleanupTimer)
  session.syntheticKillExitPtyIds.delete(id)
  return true
}

export function preparePtyExitForRenderer(
  session: PtyIpcSession,
  payload: { id: string; code: number; incarnationId?: string }
): (() => void) | null {
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
    session.sshOutputIntake?.transferPtyProjections(payload.id, 'renderer-destroyed')
    return () => {}
  }
  if (session.rendererExitingPtyIds.has(payload.id)) {
    return null
  }
  session.rendererExitingPtyIds.add(payload.id)
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    session.rendererExitingPtyIds.delete(payload.id)
  }
  try {
    if (!session.rendererCreditBeforeExitByPty.has(payload.id)) {
      session.rendererCreditBeforeExitByPty.set(
        payload.id,
        getRendererInFlightCharsForPty(session, payload.id) > 0
      )
    }
    // Why flush before exit: the renderer tears down the terminal on pty:exit, so any batched output not yet flushed would be silently lost.
    const remaining = session.pendingData.delete(payload.id)
    clearFlushTimerIfIdle(session)
    if (remaining) {
      if (remaining.droppedOutput === true) {
        // Sentinel entry: only salvaged query bytes remain; keep the flag so the renderer knows the span was dropped.
        sendPtyDataToRenderer(
          session,
          payload.id,
          {
            id: payload.id,
            data: remaining.data,
            droppedOutput: true
          },
          remaining.projectionAdmissionIds
        )
      } else {
        sendPtyDataToRenderer(
          session,
          payload.id,
          makePtyDataPayload(
            payload.id,
            remaining.data,
            remaining.startSeq,
            remaining.containsBackgroundOutput,
            remaining.rawLength,
            remaining.transformed
          ),
          remaining.projectionAdmissionIds
        )
      }
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}

export function finalizePtyExitForRenderer(
  session: PtyIpcSession,
  payload: { id: string; code: number; incarnationId?: string }
): void {
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
    session.rendererCreditBeforeExitByPty.delete(payload.id)
    return
  }
  const hadReleasableRendererCredit =
    session.rendererCreditBeforeExitByPty.get(payload.id) ??
    getRendererInFlightCharsForPty(session, payload.id) > 0
  session.rendererCreditBeforeExitByPty.delete(payload.id)
  // Why resume a dead PTY (no-op): avoid leaving a stale paused mark behind for a reused id.
  session.producerFlowControl.release(payload.id)
  session.sourceCreditPendingPtys.delete(payload.id)
  session.pendingOverflowMarkedPtys.delete(payload.id)
  session.rendererDeliveryRestoreNeededPtys.delete(payload.id)
  lastInputAtByPty.delete(payload.id)
  interactiveOutputCharsByPty.delete(payload.id)
  const releasedRendererCredit = getRendererInFlightCharsForPty(session, payload.id)
  session.rendererInFlightTotalChars = Math.max(
    0,
    session.rendererInFlightTotalChars - releasedRendererCredit
  )
  // Why: the renderer also drops its cumulative total on pty:exit, so a reused id restarts aligned at zero on both sides.
  session.rendererDeliveryAccountingByPty.delete(payload.id)
  if (hadReleasableRendererCredit) {
    if (session.pendingDataFlushActive) {
      // Why: let the open round coalesce this wake into its one post-round continuation.
      const reactivatedBlocked = session.pendingData.reactivateBlocked()
      session.pendingDataCreditReleasedDuringFlush ||= reactivatedBlocked
    } else {
      session.schedulePendingDataAfterCreditReport(true)
    }
  }
  session.mainWindow.webContents.send('pty:exit', {
    ...payload,
    ...(session.reversibleStopOwnersByPtyId.has(payload.id)
      ? { preserveRendererBinding: true }
      : {}),
    ...(consumeReplacedPtyStop(session, payload) ? { replacedByRestart: true } : {})
  })
}

export function sendPtyExitToRenderer(
  session: PtyIpcSession,
  payload: { id: string; code: number; incarnationId?: string }
): void {
  session.options?.onPtyExit?.(payload.id, allocatePtyLifecycleSequence())
  const release = preparePtyExitForRenderer(session, payload)
  if (!release) {
    return
  }
  try {
    session.sshOutputIntake?.transferPtyProjections(payload.id, 'legacy-pty-exit')
    finalizePtyExitForRenderer(session, payload)
  } finally {
    release()
  }
}

export function sendPtySpawnedToRenderer(session: PtyIpcSession, id: string): void {
  if (session.mainWindow && !session.mainWindow.isDestroyed()) {
    session.mainWindow.webContents.send('pty:spawned', { id })
  }
}
