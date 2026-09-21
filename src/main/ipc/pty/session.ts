import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { IPtyProvider } from '../../providers/types'
import type { LegacySshProjectionSemantics } from '../ssh-pty-legacy-projection'
import type { PtyModelRestoreReason } from '../../../shared/pty-model-restore-marker'
import type {
  PtyDeliveryWriteOff,
  PtyRendererDeliveryStateReport
} from '../../../shared/pty-renderer-delivery-health'
import type { PtyRendererDeliveryDebugSnapshot } from './delivery/debug'
import { PtyProducerFlowController } from '../pty-producer-flow-control'
import { PtyPendingDataDrainQueue, type PendingPtyData } from '../pty-pending-data-drain-queue'
import type { SshPtyOutputIntake } from '../ssh-pty-output-intake'
import { activeRendererPtys } from './delivery/visibility-state'
import {
  isHiddenPtyDeliveryGateEnabled,
  shouldDropHiddenRendererPtyData
} from '../pty-hidden-delivery-gate'
import type { CodexHomePtySpawnedLifecycleArgs, PrepareCodexSessionResume } from './host-env/types'
import { tryGetProviderForPty } from './provider/registry'

export type PtyDataPayload = {
  id: string
  data: string
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
}

export type RendererPtyDeliveryAccounting = {
  sentChars: number
  ackedChars: number
  lastSendAtMs: number
  lastAckAtMs: number | null
}

export type SerializeResult = {
  data: string
  cols: number
  rows: number
  seq?: number
  lastTitle?: string
  kittyKeyboardFlags?: number
} | null

export type PtyIpcSessionOptions = {
  prepareCodexSessionResume?: PrepareCodexSessionResume
  awaitLocalPtyStartup?: () => Promise<void>
  awaitLocalPtyProviderStartup?: () => Promise<void>
  // Why: returns true once for the crash-recovery reload so its did-finish-load skips the orphan sweep and keeps live PTYs (#5787).
  isRecoveryReloadInFlight?: (webContentsId: number) => boolean
  onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
  onPtyExit?: (id: string, exitSequence: number) => void
}

export type PtyIpcSession = {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
  store?: Store
  getSettings?: () => GlobalSettings
  options?: PtyIpcSessionOptions
  pendingData: PtyPendingDataDrainQueue
  sshOutputIntake: SshPtyOutputIntake | null
  rendererExitingPtyIds: Set<string>
  rendererCreditBeforeExitByPty: Map<string, boolean>
  rendererDeliveryRestoreNeededPtys: Set<string>
  pendingOverflowMarkedPtys: Set<string>
  rendererDeliveryAccountingByPty: Map<string, RendererPtyDeliveryAccounting>
  trustedTerminalHandleEnv: Set<string>
  flushTimer: ReturnType<typeof setTimeout> | null
  pendingDataFlushActive: boolean
  pendingDataCreditReleasedDuringFlush: boolean
  rendererInFlightTotalChars: number
  pendingDroppedChars: number
  deliveryResyncRequestSerial: number
  deliveryResyncOutstandingRequestId: number | null
  deliveryResyncTimer: ReturnType<typeof setTimeout> | null
  deliveryResyncUnansweredWarnLogged: boolean
  lastAckReceivedAtMs: number | null
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  rendererDispatcherReadyForcedCount: number
  rendererPtyDispatcherReady: boolean
  dispatcherReadyWatchdogTimer: ReturnType<typeof setTimeout> | null
  lastHiddenDropContradictionWarnAtMs: number
  pendingDataDropWarnedPtys: Set<string>
  producerFlowControl: PtyProducerFlowController
  sourceCreditPendingPtys: Set<string>
  backgroundedDeliverySyncByPty: Map<string, boolean>
  syntheticKillExitPtyIds: Map<string, NodeJS.Timeout>
  reversibleStopOwnersByPtyId: Map<string, number>
  retiredRejectedPtyIds: Map<string, NodeJS.Timeout>
  pendingSerializeRequests: Map<
    string,
    { resolve: (result: SerializeResult) => void; timeout: NodeJS.Timeout }
  >
  canSendPtyDataToRenderer: (id: string, options?: { interactive?: boolean }) => boolean
  schedulePendingDataFlush: (delayMs: number) => void
  flushPendingData: () => void
  sendPtyDataToRenderer: (
    id: string,
    payload: PtyDataPayload,
    projectionAdmissionIds?: readonly string[]
  ) => { sent: boolean; projectionsTransferred: boolean }
  sendModelRestoreNeededMarker: (
    id: string,
    reason: PtyModelRestoreReason,
    markerSeq: number | undefined
  ) => boolean
  updateProducerFlowControl: (id: string) => void
  applyCumulativeAck: (id: string, processedChars: number) => number
  readCurrentPtyRendererDeliveryDebugSnapshot: () => PtyRendererDeliveryDebugSnapshot
  clearDeliveryResyncProbe: () => void
  clearPendingPtyData: () => void
  deletePendingPtyData: (id: string) => void
  setPendingPtyData: (id: string, pending: PendingPtyData) => void
  clearDispatcherReadyWatchdog: () => void
  armDispatcherReadyWatchdog: () => void
  acceptPtyDataForRenderer: (
    payload: {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
    },
    outputSeq: number | undefined,
    projection?: LegacySshProjectionSemantics
  ) => void
  preparePtyExitForRenderer: (payload: {
    id: string
    code: number
    incarnationId?: string
  }) => (() => void) | null
  finalizePtyExitForRenderer: (payload: {
    id: string
    code: number
    incarnationId?: string
  }) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
  sendPtySpawnedToRenderer: (id: string) => void
  requestSerializedBuffer: (
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<SerializeResult>
  shutdownProviderAndDetectExit: (
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ) => Promise<boolean>
  rememberSyntheticKillExit: (id: string) => void
  rememberRetiredRejectedPty: (id: string) => void
  consumeSyntheticKillExit: (id: string) => boolean
  syncPtyBackgroundedDelivery: (id: string, caller: string) => void
  resyncBackgroundedDeliveriesAfterGateReset: () => void
  transitionHiddenRendererPtyDeliveryState: (
    id: string,
    hidden: boolean
  ) => { droppable: boolean; droppedWhileHidden: boolean; policyChanged: boolean }
  transitionSpawnHiddenRendererPtyDeliveryState: (id: string, hidden: boolean) => void
  rendererPtyIsKnownHidden: (id: string) => boolean
  clearHiddenRendererResizeOutput: (id: string) => void
  clearDeliveredHiddenRendererResizeOutput: (id: string) => void
  schedulePendingDataAfterCreditReport: (creditedAny: boolean) => void
  writeOffLostRendererDelivery: (report: PtyRendererDeliveryStateReport) => PtyDeliveryWriteOff[]
  getRendererInFlightCharsForPty: (id: string) => number
}

const unsetSessionFn = (): never => {
  throw new Error('pty ipc session function used before wiring')
}

export function createPtyIpcSession(args: {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
  store?: Store
  getSettings?: () => GlobalSettings
  options?: PtyIpcSessionOptions
}): PtyIpcSession {
  const session: PtyIpcSession = {
    mainWindow: args.mainWindow,
    runtime: args.runtime,
    store: args.store,
    getSettings: args.getSettings,
    options: args.options,
    pendingData: undefined as unknown as PtyPendingDataDrainQueue,
    sshOutputIntake: null,
    rendererExitingPtyIds: new Set(),
    rendererCreditBeforeExitByPty: new Map(),
    rendererDeliveryRestoreNeededPtys: new Set(),
    pendingOverflowMarkedPtys: new Set(),
    rendererDeliveryAccountingByPty: new Map(),
    trustedTerminalHandleEnv: new Set(),
    flushTimer: null,
    pendingDataFlushActive: false,
    pendingDataCreditReleasedDuringFlush: false,
    rendererInFlightTotalChars: 0,
    pendingDroppedChars: 0,
    deliveryResyncRequestSerial: 0,
    deliveryResyncOutstandingRequestId: null,
    deliveryResyncTimer: null,
    deliveryResyncUnansweredWarnLogged: false,
    lastAckReceivedAtMs: null,
    peakPendingChars: 0,
    peakMaxPendingCharsByPty: 0,
    peakRendererInFlightChars: 0,
    peakMaxRendererInFlightCharsByPty: 0,
    ackGatedFlushSkipCount: 0,
    rendererLifecycleResetCount: 0,
    lastLifecycleResetClearedChars: 0,
    rendererDispatcherReadyForcedCount: 0,
    rendererPtyDispatcherReady: false,
    dispatcherReadyWatchdogTimer: null,
    lastHiddenDropContradictionWarnAtMs: 0,
    pendingDataDropWarnedPtys: new Set(),
    producerFlowControl: new PtyProducerFlowController({
      pauseProducer: (id) => tryGetProviderForPty(id)?.pauseProducer?.(id),
      resumeProducer: (id) => tryGetProviderForPty(id)?.resumeProducer?.(id)
    }),
    sourceCreditPendingPtys: new Set(),
    backgroundedDeliverySyncByPty: new Map(),
    syntheticKillExitPtyIds: new Map(),
    reversibleStopOwnersByPtyId: new Map(),
    retiredRejectedPtyIds: new Map(),
    pendingSerializeRequests: new Map(),
    canSendPtyDataToRenderer: unsetSessionFn,
    schedulePendingDataFlush: unsetSessionFn,
    flushPendingData: unsetSessionFn,
    sendPtyDataToRenderer: unsetSessionFn,
    sendModelRestoreNeededMarker: unsetSessionFn,
    updateProducerFlowControl: unsetSessionFn,
    applyCumulativeAck: unsetSessionFn,
    readCurrentPtyRendererDeliveryDebugSnapshot: unsetSessionFn,
    clearDeliveryResyncProbe: unsetSessionFn,
    clearPendingPtyData: unsetSessionFn,
    deletePendingPtyData: unsetSessionFn,
    setPendingPtyData: unsetSessionFn,
    clearDispatcherReadyWatchdog: unsetSessionFn,
    armDispatcherReadyWatchdog: unsetSessionFn,
    acceptPtyDataForRenderer: unsetSessionFn,
    preparePtyExitForRenderer: unsetSessionFn,
    finalizePtyExitForRenderer: unsetSessionFn,
    sendPtyExitToRenderer: unsetSessionFn,
    sendPtySpawnedToRenderer: unsetSessionFn,
    requestSerializedBuffer: unsetSessionFn,
    shutdownProviderAndDetectExit: unsetSessionFn,
    rememberSyntheticKillExit: unsetSessionFn,
    rememberRetiredRejectedPty: unsetSessionFn,
    consumeSyntheticKillExit: unsetSessionFn,
    syncPtyBackgroundedDelivery: unsetSessionFn,
    resyncBackgroundedDeliveriesAfterGateReset: unsetSessionFn,
    transitionHiddenRendererPtyDeliveryState: unsetSessionFn,
    transitionSpawnHiddenRendererPtyDeliveryState: unsetSessionFn,
    rendererPtyIsKnownHidden: unsetSessionFn,
    clearHiddenRendererResizeOutput: unsetSessionFn,
    clearDeliveredHiddenRendererResizeOutput: unsetSessionFn,
    schedulePendingDataAfterCreditReport: unsetSessionFn,
    writeOffLostRendererDelivery: unsetSessionFn,
    getRendererInFlightCharsForPty: unsetSessionFn
  }

  session.pendingData = new PtyPendingDataDrainQueue(
    (id) => {
      const runnableLane = activeRendererPtys.has(id) ? 'active' : 'background'
      // Why first: hidden bytes are dropped from main's pending queue even when renderer credit is exhausted.
      if (shouldDropHiddenRendererPtyData(id, session.getSettings?.())) {
        return runnableLane
      }
      if (
        !session.rendererPtyDispatcherReady ||
        !session.canSendPtyDataToRenderer(id, { interactive: activeRendererPtys.has(id) })
      ) {
        return 'blocked'
      }
      return runnableLane
    },
    () => isHiddenPtyDeliveryGateEnabled(session.getSettings?.())
  )

  return session
}
