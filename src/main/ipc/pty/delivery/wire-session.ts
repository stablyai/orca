import { resetHiddenRendererPtyDeliveryDebugCounters } from './pty-hidden-delivery-gate'
import {
  setReadPtyRendererDeliveryDebugSnapshot,
  setResetPtyRendererDeliveryDebugSnapshot,
  setResetRendererDeliveryAccountingForLifecycleReset,
  setClearRendererDispatcherReadyWatchdog
} from './debug'
import {
  setInvalidatePendingPtyDrainPolicy,
  setInvalidatePendingPtyDrainPriority
} from './visibility-state'
import { setClearBackgroundedDeliverySyncForPty } from '../provider/listener-lifecycle'
import {
  applyCumulativeAck,
  canSendPtyDataToRenderer,
  clearDeliveryResyncProbe,
  clearPendingPtyData,
  deletePendingPtyData,
  getRendererInFlightCharsForPty,
  schedulePendingDataAfterCreditReport,
  setPendingPtyData,
  writeOffLostRendererDelivery
} from './accounting'
import {
  readCurrentPtyRendererDeliveryDebugSnapshot,
  seedPtyRendererDeliveryPeaksFromCurrentState
} from './debug-snapshot'
import {
  armDispatcherReadyWatchdog,
  clearDispatcherReadyWatchdog,
  flushPendingData,
  invalidatePendingPtyDrainClassification,
  schedulePendingDataFlush
} from './flush'
import { sendModelRestoreNeededMarker, sendPtyDataToRenderer } from './payload'
import {
  resyncBackgroundedDeliveriesAfterGateReset,
  syncPtyBackgroundedDelivery,
  updateProducerFlowControl
} from './producer-sync'
import { acceptPtyDataForRenderer, rendererPtyIsKnownHidden } from './accept'
import {
  consumeSyntheticKillExit,
  rememberRetiredRejectedPty,
  rememberSyntheticKillExit,
  sendPtyExitToRenderer,
  sendPtySpawnedToRenderer
} from './exit'
import {
  transitionHiddenRendererPtyDeliveryState,
  transitionSpawnHiddenRendererPtyDeliveryState
} from './hidden-transition'
import { requestSerializedBuffer } from '../ipc/serialize-buffer'
import { shutdownProviderAndDetectExit } from '../provider/shutdown-detect'
import type { PtyIpcSession } from '../session'

export function wirePtyIpcSession(session: PtyIpcSession): void {
  session.canSendPtyDataToRenderer = (id, options) => canSendPtyDataToRenderer(session, id, options)
  session.schedulePendingDataFlush = (delayMs) => schedulePendingDataFlush(session, delayMs)
  session.flushPendingData = () => flushPendingData(session)
  session.sendPtyDataToRenderer = (id, payload) => sendPtyDataToRenderer(session, id, payload)
  session.sendModelRestoreNeededMarker = (id, reason, markerSeq) =>
    sendModelRestoreNeededMarker(session, id, reason, markerSeq)
  session.updateProducerFlowControl = (id) => updateProducerFlowControl(session, id)
  session.applyCumulativeAck = (id, processedChars) =>
    applyCumulativeAck(session, id, processedChars)
  session.readCurrentPtyRendererDeliveryDebugSnapshot = () =>
    readCurrentPtyRendererDeliveryDebugSnapshot(session)
  session.clearDeliveryResyncProbe = () => clearDeliveryResyncProbe(session)
  session.clearPendingPtyData = () => clearPendingPtyData(session)
  session.deletePendingPtyData = (id) => deletePendingPtyData(session, id)
  session.setPendingPtyData = (id, pending) => setPendingPtyData(session, id, pending)
  session.clearDispatcherReadyWatchdog = () => clearDispatcherReadyWatchdog(session)
  session.armDispatcherReadyWatchdog = () => armDispatcherReadyWatchdog(session)
  session.acceptPtyDataForRenderer = (payload, outputSeq) =>
    acceptPtyDataForRenderer(session, payload, outputSeq)
  session.sendPtyExitToRenderer = (payload) => sendPtyExitToRenderer(session, payload)
  session.sendPtySpawnedToRenderer = (id) => sendPtySpawnedToRenderer(session, id)
  session.requestSerializedBuffer = (ptyId, opts) => requestSerializedBuffer(session, ptyId, opts)
  session.shutdownProviderAndDetectExit = (provider, id, opts) =>
    shutdownProviderAndDetectExit(provider, id, opts)
  session.rememberSyntheticKillExit = (id, incarnationId) =>
    rememberSyntheticKillExit(session, id, incarnationId)
  session.rememberRetiredRejectedPty = (id) => rememberRetiredRejectedPty(session, id)
  session.consumeSyntheticKillExit = (id, incarnationId) =>
    consumeSyntheticKillExit(session, id, incarnationId)
  session.syncPtyBackgroundedDelivery = (id, caller) =>
    syncPtyBackgroundedDelivery(session, id, caller)
  session.resyncBackgroundedDeliveriesAfterGateReset = () =>
    resyncBackgroundedDeliveriesAfterGateReset(session)
  session.transitionHiddenRendererPtyDeliveryState = (id, hidden) =>
    transitionHiddenRendererPtyDeliveryState(session, id, hidden)
  session.transitionSpawnHiddenRendererPtyDeliveryState = (id, hidden) =>
    transitionSpawnHiddenRendererPtyDeliveryState(session, id, hidden)
  session.rendererPtyIsKnownHidden = rendererPtyIsKnownHidden
  session.schedulePendingDataAfterCreditReport = (creditedAny) =>
    schedulePendingDataAfterCreditReport(session, creditedAny)
  session.writeOffLostRendererDelivery = (report) => writeOffLostRendererDelivery(session, report)
  session.getRendererInFlightCharsForPty = (id) => getRendererInFlightCharsForPty(session, id)

  setClearBackgroundedDeliverySyncForPty((id: string) => {
    session.backgroundedDeliverySyncByPty.delete(id)
  })
  if (session.runtime) {
    session.runtime.onRemoteTerminalViewPresenceChanged = (id) =>
      session.syncPtyBackgroundedDelivery(id, 'remote-view')
  }

  setReadPtyRendererDeliveryDebugSnapshot(session.readCurrentPtyRendererDeliveryDebugSnapshot)
  setResetPtyRendererDeliveryDebugSnapshot(() => {
    session.peakPendingChars = 0
    session.peakMaxPendingCharsByPty = 0
    session.peakRendererInFlightChars = 0
    session.peakMaxRendererInFlightCharsByPty = 0
    session.ackGatedFlushSkipCount = 0
    session.pendingDroppedChars = 0
    resetHiddenRendererPtyDeliveryDebugCounters()
    seedPtyRendererDeliveryPeaksFromCurrentState(session)
  })
  setResetRendererDeliveryAccountingForLifecycleReset(() => {
    // Replacement views restore from main's authoritative history, so dead-page pending delivery can be discarded.
    session.lastLifecycleResetClearedChars = session.rendererInFlightTotalChars
    session.rendererLifecycleResetCount += 1
    // Resume producers before discarding the dead page's pending bytes and credits.
    session.producerFlowControl.releaseAll()
    session.clearDeliveryResyncProbe()
    session.deliveryResyncUnansweredWarnLogged = false
    session.rendererDeliveryAccountingByPty.clear()
    session.rendererInFlightTotalChars = 0
    session.clearPendingPtyData()
    session.pendingOverflowMarkedPtys.clear()
    session.rendererDeliveryRestoreNeededPtys.clear()
    // Hold sends until the replacement dispatcher exists, or dropped sends recreate permanent debt.
    session.rendererPtyDispatcherReady = false
    // Recover if the readiness handshake never arrives; a real handshake cancels the watchdog.
    session.armDispatcherReadyWatchdog()
  })
  // Re-registration must be able to cancel this closure's readiness watchdog.
  setClearRendererDispatcherReadyWatchdog(session.clearDispatcherReadyWatchdog)
  setInvalidatePendingPtyDrainPriority((id, schedule) =>
    invalidatePendingPtyDrainClassification(session, id, schedule)
  )
  setInvalidatePendingPtyDrainPolicy((id, schedule) =>
    invalidatePendingPtyDrainClassification(session, id, schedule)
  )
}
