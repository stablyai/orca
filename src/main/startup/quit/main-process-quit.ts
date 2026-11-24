import { closeEnvironmentStore } from '../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import { app, type Event } from 'electron'
import { shutdownPairedRuntimeBrowserClientHosts } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { disposeDesktopBrowserBridge } from '../../ipc/browser/desktop-browser-bridge-wiring'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { settleTeardownWithinDeadline, type NamedQuitTeardown } from './quit-teardown-deadline'
import { quitTeardownStartGate } from './quit-teardown-start-gate'
import { destroySystemTray } from '../../tray/system-tray'
import { shutdownTelemetry } from '../../telemetry/client'
import { shutdownObservability } from '../../observability/index'
import { applyTeamPolicyBeforeQuit, isQuittingForUpdate } from '../../updater/updater-service'
import { recordUpdaterLifecycle } from '../../updater/updater-lifecycle-diagnostics'
import { pendingServeSupervisorQuitCommit } from '../../updater/lifecycle/serve-supervisor-install-park'
import { stopTccPromptNotice } from '../../macos-permissions/macos-tcc-prompt-notice'
import { installWindowAllClosedHandler } from './window-all-closed-quit-handler'
import { mainProcessState as state } from '../main-process-state'
import { isDevParentShutdownRequested } from '../configure-process'
import { closeBrowserExtensionProfileDocumentStores } from '../../browser/extensions/profile-storage/browser-extension-profile-document-store'
import { closeBrowserExtensionProfileStateStore } from '../../browser/extensions/profile-storage/browser-extension-profile-state-store'
import { flushBrowserSessionCookiesOnQuit } from '../../browser/cookies/session-restore/browser-session-cookie-restore'
import {
  beginDesktopCoreShutdown,
  fenceDesktopCore
} from '../../core-desktop/desktop-core-shutdown'

// First will-quit pass awaits teardown; the re-fired pass must exit without starting writes again.
let daemonDisconnectDone = false

function installBeforeQuitHandler(): void {
  app.on('before-quit', (event: Event) => {
    if (event.defaultPrevented) {
      return
    }
    applyTeamPolicyBeforeQuit()
    if (isQuittingForUpdate()) {
      recordUpdaterLifecycle('before_quit_allowed', undefined, {
        message: 'before-quit allowed for update install'
      })
    }
    state.isQuitting = true
    fenceDesktopCore(state.core, () => {
      state.unsubscribeAgentAwakeStatusChanges?.()
      state.unsubscribeAgentAwakeStatusChanges = null
      state.agentAwakeService?.dispose()
      state.agentAwakeService = null
    })
  })
}

function stopNativeObserversAndTray(updateQuitInProgress: boolean): void {
  state.unsubscribeSystemResumeBroadcast?.()
  state.unsubscribeSystemResumeBroadcast = null
  state.unsubscribeWakeSignalClock?.()
  state.unsubscribeWakeSignalClock = null
  state.stopDesktopPresenceReporter?.()
  state.stopDesktopPresenceReporter = null
  // Keep log-stream diagnostics alive through renderer quit vetoes.
  stopTccPromptNotice()
  if (updateQuitInProgress) {
    recordUpdaterLifecycle(
      'will_quit_cleanup_started',
      { daemonTeardown: 'disconnect' },
      { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
    )
  }
  // Remove the Windows tray icon only after renderer vetoes are past.
  destroySystemTray()
}

function retireBrowsers(): NamedQuitTeardown[] {
  const browserSessionCookieFlush = flushBrowserSessionCookiesOnQuit()
  // Await per-session close children so browser daemons cannot retain ports/state after quit (#16367); retire headless owners first to avoid duplicate fanout.
  const browserShutdown = (async (): Promise<void> => {
    await state.core.runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
    await state.core.runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  })()
  // Local SSH browser routes own loopback listeners and ssh -N -D children that must not outlive the app (P2-4).
  const localSshRouteShutdown =
    import('../../browser/routing/local-host-partitions/local-ssh-browser-route')
      .then((routes) => routes.closeAllLocalSshBrowserRoutes())
      .catch(() => {})
  browserManager.setBrowserGuestStateChangedListener(null)
  browserManager.setOffscreenTabOpener(null)
  browserManager.setServerPagePopupPresenter(null)
  return [
    { name: 'browser', promise: browserShutdown },
    { name: 'browser-session-cookies', promise: browserSessionCookieFlush },
    { name: 'local-ssh-browser-routes', promise: localSshRouteShutdown }
  ]
}

function installWillQuitHandler(): void {
  app.on('will-quit', (event: Event) => {
    // The second pass must not start fresh writes that process exit would interrupt.
    if (daemonDisconnectDone) {
      return
    }
    // Prevent exit before awaiting work. Synchronous network-profile writes would block the same thread as their deadline timer (#9447).
    if (!quitTeardownStartGate.tryStart(event)) {
      return
    }
    // A UI change still inside its debounce must reach the file before exit.
    const settingsFileShutdown = state.settingsFile?.dispose() ?? Promise.resolve()
    state.settingsFile = null
    const updateQuitInProgress = isQuittingForUpdate()
    const coreTeardowns = beginDesktopCoreShutdown(
      state.core,
      {
        store: state.store,
        releaseAdmission: () => {
          state.profileStateAdmission?.release()
          state.profileStateAdmission = undefined
        }
      },
      updateQuitInProgress ? 'update' : 'quit',
      {
        afterPushStopped: () => stopNativeObserversAndTray(updateQuitInProgress),
        retireBrowsers,
        stopUsageBackend: () => state.backend?.stop(),
        retireBrowserClientHosts: () => {
          disposeDesktopBrowserBridge()
          return [
            { name: 'browser-client-hosts', promise: shutdownPairedRuntimeBrowserClientHosts() }
          ]
        },
        isDevParentShutdown: isDevParentShutdownRequested
      }
    )
    // Bound unsettled transports and these final writes so quit cannot hang (#9447). Failures still exit; atomic swaps preserve old files if the final debounce is lost.
    // Extension storage's final save runs after this, unbounded, as its old synchronous will-quit save was.
    const teardowns = [
      ...coreTeardowns,
      { name: 'settings-file', promise: settingsFileShutdown },
      { name: 'install-park', promise: pendingServeSupervisorQuitCommit() }
    ]
    const teardownSettlement = Promise.allSettled(teardowns.map((item) => item.promise))
    settleTeardownWithinDeadline([
      ...teardowns,
      { name: 'environment-store', promise: teardownSettlement.then(closeEnvironmentStore) }
    ])
      .then((pendingTeardowns) => {
        if (pendingTeardowns.length > 0) {
          console.warn('[shutdown] Quit teardown deadline reached', { pendingTeardowns })
        }
      })
      .then(() => shutdownTelemetry())
      .then(() => shutdownObservability())
      .catch(() => {
        /* swallow — telemetry must never prevent app.quit() */
      })
      // Last before quitting, so it saves every extension write accepted during teardown.
      .then(() =>
        Promise.all([
          closeBrowserExtensionProfileDocumentStores(),
          closeBrowserExtensionProfileStateStore()
        ])
      )
      .then(() => {
        daemonDisconnectDone = true
        app.quit()
      })
  })
}

export function installMainProcessQuitHandlers(): void {
  // app.exit skips Electron quit events; stop the log child on forced exits too.
  process.once('exit', stopTccPromptNotice)
  installBeforeQuitHandler()
  installWillQuitHandler()
  installWindowAllClosedHandler()
}
