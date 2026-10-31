import { settledDaemonRestart } from '../../daemon/daemon-restart-state'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type { TerminalStartupCwdMissingDirFallback } from '../../../shared/terminal-startup-cwd'
import {
  getHiddenRendererPtyDeliveryDebug,
  resetRendererScopedHiddenPtyDeliveryState
} from './delivery/pty-hidden-delivery-gate'
import { localProvider, type ResolvedPtyHost } from './provider/registry'
import { finishPtyShutdown } from './provider/liveness'
import type { GetSelectedCodexHomePath, PrepareClaudeAuth } from './host-env/types'
import { installPtyInspectIpcHandlers } from './ipc/inspect'
import { installPtyCodexSharedServerIpcHandler } from './ipc/codex-shared-server'
import { installPtyClaudeOldTerminalIpcHandler } from './ipc/claude-old-terminal'
import { installPtyClaudeDiffPanelNoticeIpcHandler } from './ipc/claude-diff-panel-notice'
import { installPtyNewerDaemonHoldIpcHandlers } from './ipc/newer-daemon-hold'
import {
  installPtyKillIpcHandler,
  stopReplacedPanePty,
  type PtyKillIpcDeps
} from './ipc/renderer-kill'
import { installPtyWriteIpcHandlers } from './ipc/write'
import { installPtySpawnIpcHandler } from './ipc/spawn'
import { installPtyLeafMoveIpcHandler } from './ipc/leaf-move'
import { installPtyRuntimeController } from './runtime/controller'
import { installPtySnapshotIpcHandlers } from './ipc/snapshot'
import {
  assertWorkspaceAcceptsNewPty as assertWorkspaceAcceptsNewPtyImpl,
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
import { createPtyIpcSession, type PtyIpcSessionOptions, type PtyRendererDelivery } from './session'
import { wirePtyIpcSession } from './delivery/wire-session'
import { configureLocalPtyProvider } from './provider/local-configure'
import { bindProviderListeners } from './provider/bind-listeners'
import { installPtySerializeBufferIpc } from './ipc/serialize-buffer'
import { installPtyResizeVisibilityIpc } from './ipc/resize-visibility'
import { adoptStablePane } from './pane/adopt-stable'
import { getPtyIpc } from './pty-host-bindings'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  reconcileSharedRuntimeResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from './host-env/codex-resume'
import { ensureLinuxTerminalOrcaCliShimDir } from '../../cli/linux-terminal-orca-cli-shim'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function registerPtyHandlers(
  mainWindow?: PtyRendererDelivery,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  options?: PtyIpcSessionOptions
): void {
  if (process.platform === 'linux') {
    const appEnvironment = getAppEnvironment()
    if (appEnvironment.isPackaged()) {
      ensureLinuxTerminalOrcaCliShimDir({ userDataPath: appEnvironment.getPath('userData') })
    }
  }
  const ipcMain = getPtyIpc()
  // Reset the outgoing session before neutralizing its bridge, or producer pauses lose their release path.
  resetRendererDeliveryAccountingForLifecycleReset()
  // Cancel the old watchdog and neutralize its reset before new marks can touch the outgoing closure.
  clearRendererDispatcherReadyWatchdog()
  setResetRendererDeliveryAccountingForLifecycleReset(() => {})
  setInvalidatePendingPtyDrainPriority(() => {})
  setInvalidatePendingPtyDrainPolicy(() => {})
  // Provider replacement during registration must not reattach old delivery closures.
  setRebindProviderListeners(() => {})
  registerRendererLifecycleResetHandlers(mainWindow?.webContents)

  // Only local PTYs change ownership during this machine's daemon swap.
  const getLocalPtyStartupPromise = (
    hostId: ResolvedPtyHost = LOCAL_EXECUTION_HOST_ID
  ): Promise<void> | undefined => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return undefined
    }
    // Cold-start local spawns must await daemon handoff; other hosts own their startup.
    const startup = options?.awaitLocalPtyStartup?.()
    // Restart replacements must reach the new daemon.
    const restart = settledDaemonRestart()
    return startup && restart
      ? Promise.all([startup, restart]).then(() => undefined)
      : (startup ?? restart)
  }

  const getLocalPtyProviderStartupPromise = (
    hostId: ResolvedPtyHost = LOCAL_EXECUTION_HOST_ID
  ): Promise<void> | undefined => {
    return hostId === LOCAL_EXECUTION_HOST_ID
      ? (options?.awaitLocalPtyProviderStartup?.() ?? options?.awaitLocalPtyStartup?.())
      : undefined
  }

  // macOS window reactivation can re-register; remove old handlers first.
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:moveLeafToNewTab')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:killFenced')
  ipcMain.removeHandler('pty:listSessions')
  ipcMain.removeHandler('pty:hasPty')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeHandler('pty:inspectProcess')
  ipcMain.removeHandler('pty:confirmForegroundProcess')
  ipcMain.removeHandler('pty:isCodexOnSharedServer')
  ipcMain.removeHandler('pty:disableCodexSharedServerAutoStart')
  ipcMain.removeHandler('pty:stopCodexSharedServer')
  ipcMain.removeHandler('pty:openedBeforeClaudeAccounts')
  ipcMain.removeHandler('pty:claudeDiffPanelMayAutoOpen')
  ipcMain.removeHandler('pty:readNewerDaemonHeldScreen')
  ipcMain.removeHandler('pty:reopenNewerDaemonTerminals')
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
  ipcMain.removeAllListeners('pty:hiddenOutputRestoreApplied')
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
  bindProviderListeners(session)
  setRebindProviderListeners(() => bindProviderListeners(session))
  installPtySerializeBufferIpc(session)

  // Reload/crash abandons renderer marks/interest; reset them before fresh view sync.
  clearRendererGateResetHandlers()
  const resetRendererPtyDeliveryGateState = (): void => {
    const gateDebug = getHiddenRendererPtyDeliveryDebug()
    resetRendererScopedHiddenPtyDeliveryState()
    if (gateDebug.hiddenDeliveryGatedPtyCount > 0 || gateDebug.deliveryInterestPtyCount > 0) {
      invalidatePendingPtyDrainPolicy()
    }
    // Remove pacing derived from the dead page's hidden marks; fresh reports restore it.
    session.resyncBackgroundedDeliveriesAfterGateReset()
  }
  if (mainWindow) {
    setRendererGateResetState({
      contents: mainWindow.webContents,
      load: resetRendererPtyDeliveryGateState,
      gone: resetRendererPtyDeliveryGateState
    })
    mainWindow.webContents.on('did-finish-load', resetRendererPtyDeliveryGateState)
    mainWindow.webContents.on('render-process-gone', resetRendererPtyDeliveryGateState)
  }

  // Only in-process PTYs are reload orphans; daemon sessions intentionally survive.
  clearDidFinishLoadHandler()
  if (mainWindow && localProvider instanceof LocalPtyProvider) {
    const lp = localProvider
    const finishLoadHandler = () => {
      // Keep generations monotonic but skip recovery sweeps until restore re-adopts live PTYs (#5787).
      const generation = lp.advanceGeneration()
      if (options?.isRecoveryReloadInFlight?.(mainWindow.webContents.id)) {
        return
      }
      // The retained onExit callback releases ownership only after physical process exit.
      lp.killOrphanedPtys(generation - 1)
    }
    setDidFinishLoadHandler(finishLoadHandler, mainWindow.webContents)
    mainWindow.webContents.on('did-finish-load', finishLoadHandler)
  }

  const assertWorkspaceAcceptsNewPty = (
    worktreeId: string | undefined,
    sessionId?: string,
    cwd?: string,
    passiveWslRestore?: boolean,
    connectionId?: string | null
  ): Promise<void> | void =>
    assertWorkspaceAcceptsNewPtyImpl(
      store,
      worktreeId,
      sessionId,
      cwd,
      passiveWslRestore,
      connectionId
    )
  const resolvePtySpawnStartupCwd = (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback,
    connectionId?: string | null
  ): string | undefined =>
    resolvePtySpawnStartupCwdImpl(store, worktreeId, cwd, missingDirFallback, connectionId)
  const prepareCodexResumeHomeBound = (
    args: Parameters<typeof prepareCodexResumeHome>[1]
  ): ReturnType<typeof prepareCodexResumeHome> =>
    prepareCodexResumeHome(options?.prepareCodexSessionResume, args)
  const adoptStablePaneBound = (args: Parameters<typeof adoptStablePane>[2]) =>
    adoptStablePane(runtime, store, {
      ...args,
      onAdopted: (result) => session.sendPtySpawnedToRenderer(result.id)
    })

  // Resolve by PTY owner so CLI operations also reach remote providers.
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
    assertWorkspaceAcceptsNewPty,
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
    mainWindow,
    transitionSpawnHiddenRendererPtyDeliveryState:
      session.transitionSpawnHiddenRendererPtyDeliveryState,
    syncPtyBackgroundedDelivery: session.syncPtyBackgroundedDelivery
  })

  installPtySnapshotIpcHandlers({ runtime, pendingData: session.pendingData })
  const killDeps: PtyKillIpcDeps = {
    store,
    runtime,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit: session.shutdownProviderAndDetectExit,
    rememberSyntheticKillExit: session.rememberSyntheticKillExit,
    sendPtyExitToRenderer: session.sendPtyExitToRenderer
  }
  installPtyLeafMoveIpcHandler({ store, runtime })
  installPtySpawnIpcHandler({
    runtime,
    store,
    getSettings,
    getSelectedCodexHomePath,
    prepareClaudeAuth,
    options,
    getLocalPtyStartupPromise,
    adoptStablePane: adoptStablePaneBound,
    assertWorkspaceAcceptsNewPty,
    resolvePtySpawnStartupCwd,
    prepareCodexResumeHome: prepareCodexResumeHomeBound,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    transitionSpawnHiddenRendererPtyDeliveryState:
      session.transitionSpawnHiddenRendererPtyDeliveryState,
    trustedTerminalHandleEnv: session.trustedTerminalHandleEnv,
    sendPtySpawnedToRenderer: session.sendPtySpawnedToRenderer,
    syncPtyBackgroundedDelivery: session.syncPtyBackgroundedDelivery,
    stopReplacedPty: (id) => stopReplacedPanePty(killDeps, id)
  })
  installPtyWriteIpcHandlers({ mainWindow, runtime })
  installPtyResizeVisibilityIpc(session)
  installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise })
  installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise })
  installPtyClaudeOldTerminalIpcHandler({ getLocalPtyProviderStartupPromise })
  installPtyClaudeDiffPanelNoticeIpcHandler({ getLocalPtyProviderStartupPromise })
  installPtyNewerDaemonHoldIpcHandlers()
  installPtyKillIpcHandler(killDeps)
}
