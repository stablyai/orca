import { resetHiddenRendererPtyDeliveryDebugCounters } from '../../pty-hidden-delivery-gate'
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
import {
  acceptPtyDataForRenderer,
  clearDeliveredHiddenRendererResizeOutput,
  clearHiddenRendererResizeOutput,
  rendererPtyIsKnownHidden
} from './accept'
import {
  consumeSyntheticKillExit,
  finalizePtyExitForRenderer,
  preparePtyExitForRenderer,
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
  session.sendPtyDataToRenderer = (id, payload, projectionAdmissionIds) =>
    sendPtyDataToRenderer(session, id, payload, projectionAdmissionIds)
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
  session.acceptPtyDataForRenderer = (payload, outputSeq, projection) =>
    acceptPtyDataForRenderer(session, payload, outputSeq, projection)
  session.preparePtyExitForRenderer = (payload) => preparePtyExitForRenderer(session, payload)
  session.finalizePtyExitForRenderer = (payload) => finalizePtyExitForRenderer(session, payload)
  session.sendPtyExitToRenderer = (payload) => sendPtyExitToRenderer(session, payload)
  session.sendPtySpawnedToRenderer = (id) => sendPtySpawnedToRenderer(session, id)
  session.requestSerializedBuffer = (ptyId, opts) => requestSerializedBuffer(session, ptyId, opts)
  session.shutdownProviderAndDetectExit = (provider, id, opts) =>
    shutdownProviderAndDetectExit(provider, id, opts)
  session.rememberSyntheticKillExit = (id) => rememberSyntheticKillExit(session, id)
  session.rememberRetiredRejectedPty = (id) => rememberRetiredRejectedPty(session, id)
  session.consumeSyntheticKillExit = (id) => consumeSyntheticKillExit(session, id)
  session.syncPtyBackgroundedDelivery = (id, caller) =>
    syncPtyBackgroundedDelivery(session, id, caller)
  session.resyncBackgroundedDeliveriesAfterGateReset = () =>
    resyncBackgroundedDeliveriesAfterGateReset(session)
  session.transitionHiddenRendererPtyDeliveryState = (id, hidden) =>
    transitionHiddenRendererPtyDeliveryState(session, id, hidden)
  session.transitionSpawnHiddenRendererPtyDeliveryState = (id, hidden) =>
    transitionSpawnHiddenRendererPtyDeliveryState(session, id, hidden)
  session.rendererPtyIsKnownHidden = rendererPtyIsKnownHidden
  session.clearHiddenRendererResizeOutput = clearHiddenRendererResizeOutput
  session.clearDeliveredHiddenRendererResizeOutput = clearDeliveredHiddenRendererResizeOutput
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
    // Why lossless: pendingData bytes were bound for the dead page; the replacement repaints from main's authoritative sources, which superset it.
    session.lastLifecycleResetClearedChars = session.rendererInFlightTotalChars
    session.rendererLifecycleResetCount += 1
    // Why release before clearing: pending bytes and credits belonged to the dead page; releasing producer pauses first keeps no shell wedged.
    session.producerFlowControl.releaseAll()
    session.clearDeliveryResyncProbe()
    session.deliveryResyncUnansweredWarnLogged = false
    for (const id of session.rendererDeliveryAccountingByPty.keys()) {
      session.sshOutputIntake?.transferPtyProjections(id, 'renderer-lifecycle-reset')
    }
    session.rendererDeliveryAccountingByPty.clear()
    session.rendererInFlightTotalChars = 0
    session.clearPendingPtyData()
    session.pendingOverflowMarkedPtys.clear()
    session.rendererDeliveryRestoreNeededPtys.clear()
    // Why hold sends: the reloading page's pty:data listener is gone until it re-registers/handshakes, so bytes would drop into a listener-less page and re-pin the gate.
    session.rendererPtyDispatcherReady = false
    // Why: arm the self-heal watchdog so a never-arriving handshake can't hold the gate forever; the real handshake cancels it.
    session.armDispatcherReadyWatchdog()
  })
  // Why the bridge: let a later re-registration cancel this closure's watchdog (armed via a hoisted fn, so this assignment can precede its definition).
  setClearRendererDispatcherReadyWatchdog(session.clearDispatcherReadyWatchdog)
  setInvalidatePendingPtyDrainPriority((id, schedule) =>
    invalidatePendingPtyDrainClassification(session, id, schedule)
  )
  setInvalidatePendingPtyDrainPolicy((id, schedule) =>
    invalidatePendingPtyDrainClassification(session, id, schedule)
  )
}
