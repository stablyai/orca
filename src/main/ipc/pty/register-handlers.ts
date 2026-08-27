import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type { TerminalStartupCwdMissingDirFallback } from '../../../shared/terminal-startup-cwd'
import {
  getHiddenRendererPtyDeliveryDebug,
  resetRendererScopedHiddenPtyDeliveryState
} from '../pty-hidden-delivery-gate'
import { localProvider } from './provider/registry'
import { finishPtyShutdown } from './provider/liveness'
import type { GetSelectedCodexHomePath, PrepareClaudeAuth } from './host-env/types'
import { installPtyInspectIpcHandlers } from './ipc/inspect'
import { installPtyWriteIpcHandlers } from './ipc/write'
import { installPtySpawnIpcHandler } from './ipc/spawn'
import { installPtyRuntimeController } from './runtime/controller'
import { installPtySnapshotIpcHandlers } from './ipc/snapshot'
import {
  assertFolderWorkspacePtyPathUsable as assertFolderWorkspacePtyPathUsableImpl,
  localStartupCwdDirectoryExists,
  resolvePtySpawnStartupCwd as resolvePtySpawnStartupCwdImpl
} from './host-env/spawn-cwd'
import {
  setInvalidatePendingPtyDrainPolicy,
  setInvalidatePendingPtyDrainPriority,
  invalidatePendingPtyDrainPolicy
} from './delivery/visibility-state'
import {
  setRebindProviderListeners,
  setDidFinishLoadHandler,
  setRendererGateResetState
} from './provider/listener-lifecycle'
import {
  resetRendererDeliveryAccountingForLifecycleReset,
  setResetRendererDeliveryAccountingForLifecycleReset,
  clearRendererDispatcherReadyWatchdog
} from './delivery/debug'
import {
  registerRendererLifecycleResetHandlers,
  clearRendererGateResetHandlers,
  clearDidFinishLoadHandler
} from './delivery/lifecycle-reset'
import { createPtyIpcSession, type PtyIpcSessionOptions } from './session'
import { wirePtyIpcSession } from './delivery/wire-session'
import { configureLocalPtyProvider } from './provider/local-configure'
import { bindProviderListeners } from './provider/bind-listeners'
import { installSessionSshOutputIntake } from './delivery/ssh-intake'
import { installPtySerializeBufferIpc } from './ipc/serialize-buffer'
import { installPtyResizeVisibilityIpc } from './ipc/resize-visibility'
import { adoptStablePane } from './pane/adopt-stable'
import { getPtyIpc } from '../pty-host-bindings'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  reconcileSharedRuntimeResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from './host-env/codex-resume'

export function registerPtyHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  options?: PtyIpcSessionOptions
): void {
  const ipcMain = getPtyIpc()
  // Why first: the outgoing session owns the producer pauses, so its real reset must run
  // before the bridge is neutralized or a PTY paused during re-registration stays paused.
  resetRendererDeliveryAccountingForLifecycleReset()
  // Why: a re-registration means a new window owns delivery — cancel the prior closure's watchdog and neutralize its bridged reset so mark-hidden below can't arm a timer against the dead closure.
  clearRendererDispatcherReadyWatchdog()
  setResetRendererDeliveryAccountingForLifecycleReset(() => {})
  setInvalidatePendingPtyDrainPriority(() => {})
  setInvalidatePendingPtyDrainPolicy(() => {})
  // Why: neutralize rebind at the same moment as drain so a daemon replace in this window cannot attach the old accept/exit closures.
  setRebindProviderListeners(() => {})
  registerRendererLifecycleResetHandlers(mainWindow.webContents)

  const getLocalPtyStartupPromise = (connectionId?: string | null): Promise<void> | undefined => {
    if (connectionId) {
      return undefined
    }
    // Why: during cold start the daemon provider swap overlaps first paint, so local spawns must wait; SSH/headless don't use the desktop daemon.
    return options?.awaitLocalPtyStartup?.()
  }

  const getLocalPtyProviderStartupPromise = (
    connectionId?: string | null
  ): Promise<void> | undefined => {
    if (connectionId) {
      return undefined
    }
    return options?.awaitLocalPtyProviderStartup?.() ?? options?.awaitLocalPtyStartup?.()
  }

  // Remove prior handlers so re-registration (e.g. macOS re-activate creating a new window) doesn't double-register.
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasPty')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeHandler('pty:inspectProcess')
  ipcMain.removeHandler('pty:confirmForegroundProcess')
  ipcMain.removeHandler('pty:getCwd')
  ipcMain.removeHandler('pty:getSize')
  ipcMain.removeHandler('pty:getAuthoritativeBufferSnapshotCapabilities')
  ipcMain.removeHandler('pty:declarePendingPaneSerializer')
  ipcMain.removeHandler('pty:settlePaneSerializer')
  ipcMain.removeHandler('pty:clearPendingPaneSerializer')
  ipcMain.removeHandler('pty:reportRendererSerializerReady')
  ipcMain.removeHandler('pty:getMainBufferSnapshot')
  ipcMain.removeHandler('pty:sideEffectSnapshot')
  ipcMain.removeHandler('pty:getRendererDeliveryDebugSnapshot')
  ipcMain.removeHandler('pty:resetRendererDeliveryDebug')
  ipcMain.removeHandler('pty:reportRendererDeliveryState')
  ipcMain.removeHandler('pty:writeAccepted')
  ipcMain.removeAllListeners('pty:write')
  ipcMain.removeAllListeners('pty:ackColdRestore')
  ipcMain.removeAllListeners('pty:ackData')
  ipcMain.removeAllListeners('pty:deliveryResyncResponse')
  ipcMain.removeAllListeners('pty:serializeBuffer:response')

  const session = createPtyIpcSession({
    mainWindow,
    runtime,
    store,
    getSettings,
    options
  })
  wirePtyIpcSession(session)
  configureLocalPtyProvider({
    runtime,
    getSettings,
    getSelectedCodexHomePath,
    trustedTerminalHandleEnv: session.trustedTerminalHandleEnv
  })
  installSessionSshOutputIntake(session)
  bindProviderListeners(session)
  setRebindProviderListeners(() => bindProviderListeners(session))
  installPtySerializeBufferIpc(session)

  // Why: reload/crash orphans delivery-interest holds and hidden marks; reset so surviving PTYs aren't stuck force-fed or gated — each pane's first sync re-marks.
  clearRendererGateResetHandlers()
  const resetRendererPtyDeliveryGateState = (): void => {
    const gateDebug = getHiddenRendererPtyDeliveryDebug()
    resetRendererScopedHiddenPtyDeliveryState()
    if (gateDebug.hiddenDeliveryGatedPtyCount > 0 || gateDebug.deliveryInterestPtyCount > 0) {
      invalidatePendingPtyDrainPolicy()
    }
    // Why: the daemon pacer must not keep throttling ptys whose hidden marks died with the renderer; the fresh renderer's sync re-marks the still-hidden ones.
    session.resyncBackgroundedDeliveriesAfterGateReset()
  }
  setRendererGateResetState({
    contents: mainWindow.webContents,
    load: resetRendererPtyDeliveryGateState,
    gone: resetRendererPtyDeliveryGateState
  })
  mainWindow.webContents.on('did-finish-load', resetRendererPtyDeliveryGateState)
  mainWindow.webContents.on('render-process-gone', resetRendererPtyDeliveryGateState)

  // Why: only LocalPtyProvider PTYs (main-process) can be orphaned on reload; daemon sessions survive by design and cleanup would kill them.
  clearDidFinishLoadHandler()
  if (localProvider instanceof LocalPtyProvider) {
    const lp = localProvider
    const finishLoadHandler = () => {
      // Why: always advance to keep the generation monotonic, but skip the sweep on crash/freeze-recovery reload — it would kill live local PTYs before session restore (#5787).
      const generation = lp.advanceGeneration()
      if (options?.isRecoveryReloadInFlight?.(mainWindow.webContents.id)) {
        return
      }
      // Why: the retained provider onExit callback is the only physical-exit proof; it clears ownership after the OS reaps it.
      lp.killOrphanedPtys(generation - 1)
    }
    setDidFinishLoadHandler(finishLoadHandler, mainWindow.webContents)
    mainWindow.webContents.on('did-finish-load', finishLoadHandler)
  }

  const assertFolderWorkspacePtyPathUsable = (
    worktreeId: string | undefined
  ): Promise<void> | void => assertFolderWorkspacePtyPathUsableImpl(store, worktreeId)
  const resolvePtySpawnStartupCwd = (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ): string | undefined => resolvePtySpawnStartupCwdImpl(store, worktreeId, cwd, missingDirFallback)
  const prepareCodexResumeHomeBound = (
    args: Parameters<typeof prepareCodexResumeHome>[1]
  ): ReturnType<typeof prepareCodexResumeHome> =>
    prepareCodexResumeHome(options?.prepareCodexSessionResume, args)
  const adoptStablePaneBound = (args: Parameters<typeof adoptStablePane>[2]) =>
    adoptStablePane(runtime, store, args)

  // Why: route through getProviderForPty() so CLI commands work for remote PTYs too; localProvider would silently fail for them.
  installPtyRuntimeController({
    runtime,
    store,
    adoptStablePane: adoptStablePaneBound,
    getLocalPtyStartupPromise,
    getLocalPtyProviderStartupPromise,
    prepareCodexResumeHome: prepareCodexResumeHomeBound,
    resolveCodexResumeLaunch,
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    assertFolderWorkspacePtyPathUsable,
    resolvePtySpawnStartupCwd,
    requestSerializedBuffer: session.requestSerializedBuffer,
    shutdownProviderAndDetectExit: session.shutdownProviderAndDetectExit,
    rememberSyntheticKillExit: session.rememberSyntheticKillExit,
    rememberRetiredRejectedPty: session.rememberRetiredRejectedPty,
    sendPtyExitToRenderer: session.sendPtyExitToRenderer,
    sendPtySpawnedToRenderer: session.sendPtySpawnedToRenderer,
    finishPtyShutdown,
    getSettings,
    getSelectedCodexHomePath,
    prepareClaudeAuth,
    options,
    trustedTerminalHandleEnv: session.trustedTerminalHandleEnv,
    retiredRejectedPtyIds: session.retiredRejectedPtyIds,
    reversibleStopOwnersByPtyId: session.reversibleStopOwnersByPtyId,
    mainWindow
  })

  installPtySnapshotIpcHandlers({ runtime, pendingData: session.pendingData })
  installPtySpawnIpcHandler({
    runtime,
    store,
    getSettings,
    getSelectedCodexHomePath,
    prepareClaudeAuth,
    options,
    getLocalPtyStartupPromise,
    adoptStablePane: adoptStablePaneBound,
    assertFolderWorkspacePtyPathUsable,
    resolvePtySpawnStartupCwd,
    localStartupCwdDirectoryExists,
    prepareCodexResumeHome: prepareCodexResumeHomeBound,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    transitionSpawnHiddenRendererPtyDeliveryState:
      session.transitionSpawnHiddenRendererPtyDeliveryState,
    trustedTerminalHandleEnv: session.trustedTerminalHandleEnv,
    sendPtySpawnedToRenderer: session.sendPtySpawnedToRenderer,
    syncPtyBackgroundedDelivery: session.syncPtyBackgroundedDelivery
  })
  installPtyWriteIpcHandlers({
    mainWindow,
    runtime,
    clearHiddenRendererResizeOutput: session.clearHiddenRendererResizeOutput
  })
  installPtyResizeVisibilityIpc(session)
  installPtyInspectIpcHandlers({
    store,
    runtime,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit: session.shutdownProviderAndDetectExit,
    rememberSyntheticKillExit: session.rememberSyntheticKillExit,
    sendPtyExitToRenderer: session.sendPtyExitToRenderer
  })
}
