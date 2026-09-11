import {
  interactiveOutputCharsByPty,
  lastInputAtByPty,
  SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS
} from './visibility-state'
import { allocatePtyLifecycleSequence } from '../host-env/types'
import { makePtyDataPayload, sendPtyDataToRenderer } from './payload'
import { getRendererInFlightCharsForPty } from './accounting'
import { clearFlushTimerIfIdle } from './flush'
import type { PtyIpcSession } from '../session'

export function rememberSyntheticKillExit(session: PtyIpcSession, id: string): void {
  const existing = session.syntheticKillExitPtyIds.get(id)
  if (existing) {
    clearTimeout(existing)
  }
  // Why a timed window: providers may report the real exit after kill completes; skip only that late duplicate, not a future reused id forever.
  const cleanupTimer = setTimeout(() => {
    session.syntheticKillExitPtyIds.delete(id)
  }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
  cleanupTimer.unref?.()
  session.syntheticKillExitPtyIds.set(id, cleanupTimer)
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

export function consumeSyntheticKillExit(session: PtyIpcSession, id: string): boolean {
  const cleanupTimer = session.syntheticKillExitPtyIds.get(id)
  if (!cleanupTimer) {
    return false
  }
  clearTimeout(cleanupTimer)
  session.syntheticKillExitPtyIds.delete(id)
  return true
}

export function preparePtyExitForRenderer(
  session: PtyIpcSession,
  payload: { id: string; code: number; incarnationId?: string }
): (() => void) | null {
  if (session.mainWindow.isDestroyed()) {
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
  if (session.mainWindow.isDestroyed()) {
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
      : {})
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
  if (!session.mainWindow.isDestroyed()) {
    session.mainWindow.webContents.send('pty:spawned', { id })
  }
}
