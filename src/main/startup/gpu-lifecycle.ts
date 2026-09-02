import { app, type BrowserWindow } from 'electron'
import { relaunchApp } from '../app-relaunch'
import { destroySystemTray } from '../tray/system-tray'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'
import {
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type WindowsGpuFallbackEnvironment
} from './gpu-fallback-marker'
import {
  handleGpuFallbackRecoveredLaunch,
  promptForGpuFallbackRecoveredLaunch
} from '../crash-reporting/gpu-fallback-recovered-launch'
import { promptForGpuFallbackRestart } from '../crash-reporting/gpu-fallback-restart-prompt'
import { engageGpuFallbackAfterCrashBurst } from '../crash-reporting/gpu-fallback-engagement'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { mainProcessState as state, gpuFallbackEnvironment } from './main-process-state'
import { createGpuAccelerationAboutPanelOptions } from '../menu/gpu-acceleration-about-panel'

export function updateGpuAccelerationAboutPanel(): void {
  app.setAboutPanelOptions(
    createGpuAccelerationAboutPanelOptions({
      appName: app.name,
      appVersion: app.getVersion(),
      platform: process.platform,
      gpuFallbackActive: state.gpuFallbackActiveThisLaunch,
      gpuFeatureStatus: state.gpuFeatureStatus
    })
  )
}

function getWindowsGpuFallbackEnvironment(): WindowsGpuFallbackEnvironment | null {
  const environment = gpuFallbackEnvironment()
  return environment.platform === 'win32' ? { ...environment, platform: 'win32' } : null
}

// Writes both crash-time and post-recovery consent states through one build-scoped path.
function persistGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; userConfirmed: boolean }
): boolean {
  const environment = getWindowsGpuFallbackEnvironment()
  if (!environment) {
    return false
  }
  try {
    writeGpuFallbackMarker(userDataPath, info, environment)
    return true
  } catch (error) {
    console.warn('[gpu-fallback] failed to persist marker:', error)
    return false
  }
}

// Read before app.whenReady() so app.disableHardwareAcceleration() takes effect. Windows desktop only.
export function maybeApplyGpuFallbackForThisLaunch(): void {
  if (state.isServeMode || process.platform !== 'win32') {
    return
  }
  const marker = readActiveGpuFallbackMarker(app.getPath('userData'), gpuFallbackEnvironment())
  if (!marker) {
    return
  }
  state.activeGpuFallbackMarker = marker
  app.disableHardwareAcceleration()
  const appliedSwitches = applyGpuFallbackCommandLineSwitches(app.commandLine, process.platform)
  state.gpuFallbackActiveThisLaunch = true
  // Why: with no GPU child left, child-process-gone can't report a GPU fault, so
  // name the applied switches in the trail any later crash report carries.
  recordCrashBreadcrumb('gpu_fallback_applied', {
    crashesInWindow: marker.crashesInWindow,
    switches: appliedSwitches.join(',')
  })
}

export async function presentGpuFallbackRecoveredLaunchPrompt(
  window: BrowserWindow
): Promise<void> {
  const marker = state.activeGpuFallbackMarker
  if (!marker || marker.userConfirmed || window.isDestroyed() || state.isQuitting) {
    return
  }
  // One prompt per process. A failure leaves the on-disk marker unconfirmed so the next launch retries.
  state.activeGpuFallbackMarker = null
  const userDataPath = app.getPath('userData')
  await handleGpuFallbackRecoveredLaunch({
    isQuitting: () => state.isQuitting,
    prompt: () => promptForGpuFallbackRecoveredLaunch(window),
    confirmSafeGraphics: () => {
      persistGpuFallbackMarker(userDataPath, {
        engagedAt: marker.engagedAt,
        crashesInWindow: marker.crashesInWindow,
        userConfirmed: true
      })
    },
    clearSafeGraphics: () => clearGpuFallbackMarker(userDataPath),
    onPromptFailed: (error) =>
      console.warn('[gpu-fallback] failed to show recovered-launch prompt:', error),
    onSafeGraphicsKept: () =>
      recordDurableCrashBreadcrumb('gpu_fallback_safe_graphics_kept', {
        crashesInWindow: marker.crashesInWindow
      }),
    restartWithHardware: () => {
      state.isQuitting = true
      relaunchApp('gpu-fallback', {
        mode: 'hardware-retry',
        crashesInWindow: marker.crashesInWindow
      })
      destroySystemTray()
      app.exit(0)
    }
  })
}

// Why: a burst of GPU child crashes means HW acceleration is unusable — persist a build-scoped marker and offer software rendering.
export async function handleGpuChildCrash(
  reason: string,
  exitCode: number | null,
  crashedAt: number
): Promise<void> {
  // Software rendering already active or shutting down: nothing more to do.
  if (state.gpuFallbackActiveThisLaunch || state.isQuitting || state.isServeMode) {
    return
  }
  const result = state.gpuCrashFallbackTracker.recordGpuCrash(crashedAt)
  if (!result.shouldEngageFallback) {
    return
  }
  const fallbackData = { processReason: reason, exitCode, crashesInWindow: result.crashesInWindow }
  const userDataPath = app.getPath('userData')
  await engageGpuFallbackAfterCrashBurst(
    { reason, exitCode, crashesInWindow: result.crashesInWindow, engagedAt: Date.now() },
    {
      isQuitting: () => state.isQuitting,
      onEngaged: (engagement) =>
        recordCrashBreadcrumb('gpu_fallback_engaged', {
          reason: engagement.reason,
          exitCode: engagement.exitCode,
          crashesInWindow: engagement.crashesInWindow
        }),
      persistMarker: (engagement) =>
        persistGpuFallbackMarker(userDataPath, {
          engagedAt: engagement.engagedAt,
          crashesInWindow: engagement.crashesInWindow,
          userConfirmed: false
        }),
      confirmMarker: (engagement) => {
        persistGpuFallbackMarker(userDataPath, {
          engagedAt: engagement.engagedAt,
          crashesInWindow: engagement.crashesInWindow,
          userConfirmed: true
        })
      },
      clearMarker: () => clearGpuFallbackMarker(userDataPath),
      promptForRestart: () =>
        promptForGpuFallbackRestart(
          state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined
        ),
      onPromptFailed: (error) =>
        console.warn('[gpu-fallback] failed to show restart prompt:', error),
      onRestartDeferred: () =>
        recordDurableCrashBreadcrumb('gpu_fallback_restart_deferred', fallbackData),
      restartIntoSafeGraphics: () => {
        state.isQuitting = true
        relaunchApp('gpu-fallback', fallbackData)
        destroySystemTray()
        app.exit(0)
      }
    }
  )
}

export function registerGpuLifecycleHandlers(): void {
  app.on('gpu-info-update', () => {
    state.gpuFeatureStatus = app.getGPUFeatureStatus()
    state.gpuCrashDiagnostics?.warm()
    if (app.isReady()) {
      updateGpuAccelerationAboutPanel()
    }
  })
}
