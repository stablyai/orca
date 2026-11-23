import { app, nativeTheme, shell } from 'electron'
import { initializeNotchAgentStatus } from '../notch/notch-desktop-lifecycle'
import { performance } from 'node:perf_hooks'
import { AgentBrowserBridge } from '../browser/agent-browser/agent-browser-bridge'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { browserSessionRegistry } from '../browser/sessions/profiles/browser-session-registry'
import { configureBrowserClientPageAutomationRuntime } from '../browser/client-pages/execution/browser-client-page-automation-runtime'
import { openOffscreenBrowserPageLink } from '../runtime/browser/commands/offscreen-browser-page-link'
import { startPreGoneCrashSampling } from '../crash-reporting/process-exits/process-gone-diagnostics'
import { setMainMemorySpikeCounts } from '../memory/main-memory-spike-capture'
import { registeredPtyCount } from '../memory/pty-registry'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { refuseRealtimeSchedulingUnderZeroRtTime } from './linux-runtime/linux-realtime-scheduling-guard'
import { recordProcessGoneCrash } from './main-window/main-window-lifecycle-flags'
import { handleGpuChildCrash } from './gpu-recovery/gpu-lifecycle'
import { isGpuFallbackCrashCandidate } from '../crash-reporting/recovery/gpu-crash-fallback-decision'
import { mainProcessState as state } from './main-process-state'
import { initializeMainProcessObservers, startUsageBackend } from './main-process-observers'
import { runAfterFirstWindowShown } from './main-window/first-window-deferral'
import { startSpeechModelWarmup } from '../speech/speech-model-warmup'
import { startClaudeCodeThemeSync } from '../claude/theme-sync/claude-code-theme-sync-schedule'
import {
  composeDesktopCore,
  type DesktopCoreNative
} from '../core-desktop/desktop-core-composition'
import type { Store } from '../persistence/loading-store/store'
import type { RuntimeDesktopWindowStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'

function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const activation = state.desktopActivationGate
  if (!activation) {
    return 'available'
  }
  const value = activation.getState()
  return value === 'ready' ? 'openable' : value
}

function startProcessCrashObservers(): void {
  setMainMemorySpikeCounts(() => ({
    openChats: getStructuredAgentSessionHost()?.reads.openConversationCount() ?? 0,
    workspaces: Object.keys(state.store?.getAllWorktreeMeta() ?? {}).length,
    projects: state.store?.getRepos().length ?? 0,
    bots: state.store?.getBots().length ?? 0,
    terminals: registeredPtyCount()
  }))
  // Sample live processes: gone-time metrics omit dead children and already-released memory.
  startPreGoneCrashSampling()
  app.on('child-process-gone', (_event, details) => {
    recordProcessGoneCrash('child', details.type, details.reason, details.exitCode ?? null, {
      name: details.name,
      serviceName: details.serviceName,
      type: details.type
    })
    if (
      isGpuFallbackCrashCandidate({
        platform: process.platform,
        processType: details.type,
        reason: details.reason
      })
    ) {
      const crashedAt = performance.now()
      void state.gpuCrashDiagnostics?.record()
      void handleGpuChildCrash(details.reason, details.exitCode ?? null, crashedAt)
    }
  })
}

function startThemeAndSpeech(store: Store, fallbackMs: number): void {
  // Load the dictation model after first paint; coming back to Orca re-warms one the idle timer unloaded.
  runAfterFirstWindowShown(() => {
    app.on('browser-window-focus', startSpeechModelWarmup(store))
  }, fallbackMs)
  runAfterFirstWindowShown(() => {
    startClaudeCodeThemeSync({
      getSettings: () => store.getSettings(),
      onSettingsChanged: (listener) => store.onSettingsChanged(listener),
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
      onSystemThemeChanged: (listener) => nativeTheme.on('updated', listener),
      onAppFocused: (listener) => app.on('browser-window-focus', listener),
      userDataPath: app.getPath('userData')
    })
  }, fallbackMs)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
}

function desktopCoreNative(store: Store): DesktopCoreNative {
  return {
    isQuitting: () => state.isQuitting,
    isServeMode: () => state.isServeMode,
    servedOrcaProfileId: () => state.activeOrcaProfile?.profile.id,
    openExternal: (url) => shell.openExternal(url),
    startObservers: () => initializeMainProcessObservers(store),
    getWorkingAgentCount: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0,
    startUsageBackend,
    getDesktopWindowStatus,
    sendTerminalSideEffects: (batch) => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    attachBrowserHost: (runtime) => {
      browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
        runtime.notifyMobileSessionTabsChanged(worktreeId)
      })
      browserManager.setOffscreenTabOpener((request) =>
        openOffscreenBrowserPageLink(
          (params, caller) => runtime.browserTabCreate(params, caller),
          request
        )
      )
      browserManager.setServerPagePopupPresenter((popup) => {
        void runtime.showServerPagePopupToClient(popup).catch((error: unknown) => {
          console.warn('[browser] could not show a page popup to its client:', error)
        })
      })
      browserSessionRegistry.onProfilesChanged = () => runtime.notifyBrowserProfilesChanged()
    },
    createAgentBrowserBridge: (onTabsChanged) => {
      state.agentBrowserBridge = new AgentBrowserBridge(browserManager, { onTabsChanged })
      return state.agentBrowserBridge
    },
    configureBrowserAutomation: (executeRpc) =>
      configureBrowserClientPageAutomationRuntime({
        browserManager,
        getAgentBrowserBridge: () => state.agentBrowserBridge,
        executeRpc
      }),
    afterFirstWindowShown: runAfterFirstWindowShown,
    startThemeAndSpeech: (fallbackMs) => startThemeAndSpeech(store, fallbackMs),
    startCrashObservers: startProcessCrashObservers
  }
}

export async function initializeReadyRuntimeServices(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before ready services')
  }
  // Renderers fork from zygotes that exist already, so this must land before the first window.
  await refuseRealtimeSchedulingUnderZeroRtTime()
  await composeDesktopCore(state.core, {
    store,
    paths: {
      userData: app.getPath('userData'),
      home: app.getPath('home'),
      isPackaged: app.isPackaged
    },
    native: desktopCoreNative(store),
    registerCleanup: (cleanup) => app.once('will-quit', cleanup)
  })
  initializeNotchAgentStatus()
}
