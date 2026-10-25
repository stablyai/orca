import { ptyIncarnationById } from '../provider/ownership-state'
import { resolvePtyExecutionHost } from '../provider/registry'
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

function preparePtyExitForRenderer(
  session: PtyIpcSession,
  payload: { id: string; code: number; incarnationId?: string }
): (() => void) | null {
  if (!session.mainWindow || session.mainWindow.isDestroyed()) {
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
    // Flush before pty:exit tears down the renderer terminal and loses remaining output.
    const remaining = session.pendingData.delete(payload.id)
    clearFlushTimerIfIdle(session)
    if (remaining) {
      if (remaining.droppedOutput === true) {
        // Preserve the drop flag even when only salvaged query bytes remain.
        sendPtyDataToRenderer(session, payload.id, {
          id: payload.id,
          data: remaining.data,
          droppedOutput: true
        })
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
          )
        )
      }
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}

function finalizePtyExitForRenderer(
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
  // Release pause bookkeeping so reused IDs cannot inherit it.
  session.producerFlowControl.release(payload.id)
  session.pendingOverflowMarkedPtys.delete(payload.id)
  session.rendererDeliveryRestoreNeededPtys.delete(payload.id)
  lastInputAtByPty.delete(payload.id)
  interactiveOutputCharsByPty.delete(payload.id)
  const releasedRendererCredit = getRendererInFlightCharsForPty(session, payload.id)
  session.rendererInFlightTotalChars = Math.max(
    0,
    session.rendererInFlightTotalChars - releasedRendererCredit
  )
  // Renderer resets cumulative ACKs on exit; reused IDs must restart aligned at zero.
  session.rendererDeliveryAccountingByPty.delete(payload.id)
  if (hadReleasableRendererCredit) {
    if (session.pendingDataFlushActive) {
      // Coalesce credit-release wakeups into this round's single continuation.
      const reactivatedBlocked = session.pendingData.reactivateBlocked()
      session.pendingDataCreditReleasedDuringFlush ||= reactivatedBlocked
    } else {
      session.schedulePendingDataAfterCreditReport(true)
    }
  }
  const intentionalStops =
    session.runtime?.intentionalPtyStops?.claimExit(payload.id, payload.incarnationId) ?? []
  session.mainWindow.webContents.send('pty:exit', {
    ...payload,
    hostId: resolvePtyExecutionHost(payload.id),
    ...(intentionalStops.includes('reversible') ? { preserveRendererBinding: true } : {}),
    ...(intentionalStops.includes('replaced') ? { replacedByRestart: true } : {})
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
    finalizePtyExitForRenderer(session, payload)
  } finally {
    release()
  }
}

export function sendPtySpawnedToRenderer(session: PtyIpcSession, id: string): void {
  if (session.mainWindow && !session.mainWindow.isDestroyed()) {
    session.mainWindow.webContents.send('pty:spawned', {
      id,
      incarnationId: ptyIncarnationById.get(id),
      hostId: resolvePtyExecutionHost(id)
    })
  }
}
