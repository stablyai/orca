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
import { GpuCrashDiagnosticsRecorder } from '../crash-reporting/gpu-crash-diagnostics'
import {
  isInstallDirAclRepairExhausted,
  isInstallDirAclRepairPending,
  isInstallDirAclSuspect,
  waitForInstallDirAclVerdict
} from './windows-install-dir-acl-recovery'
import { mainProcessState as state, gpuFallbackEnvironment } from './main-process-state'
import { createGpuAccelerationAboutPanelOptions } from '../menu/gpu-acceleration-about-panel'

export function createGpuCrashDiagnosticsRecorder(): GpuCrashDiagnosticsRecorder | null {
  if (process.platform !== 'win32') {
    return null
  }
  return new GpuCrashDiagnosticsRecorder({
    provider: {
      getGPUInfo: (infoType) => app.getGPUInfo(infoType),
      getGPUFeatureStatus: () => app.getGPUFeatureStatus()
    },
    recordBreadcrumb: (data) => recordDurableCrashBreadcrumb('gpu_crash_hardware', data)
  })
}

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

// Apply before ready for hardware-acceleration selection; Windows desktop only.
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
  // Fallback removes the GPU child and its death reports; record applied switches for later crash evidence.
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
  // One prompt per process; failures leave the disk marker unconfirmed for next launch.
  state.activeGpuFallbackMarker = null
  const userDataPath = app.getPath('userData')
  // The pre-window ACL gate may have retired this marker; consent must not pin repaired hardware to software.
  if (!readActiveGpuFallbackMarker(userDataPath, gpuFallbackEnvironment())) {
    return
  }
  // While ACL remains suspect, stay silent so consent cannot pin an unrepairable userConfirmed marker. Successful repair can retire unconfirmed markers.
  if (isInstallDirAclSuspect()) {
    return
  }
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

/** Withhold only while repair has attempts left; indefinite suspicion also catches healthy installs and would deny their remaining safe-graphics recovery. */
function installDirAclWithholdsGpuFallback(): boolean {
  return isInstallDirAclSuspect() && !isInstallDirAclRepairExhausted()
}

/** Poisoned DACL mimics driver failure, but in-process GPU hides sibling-death evidence without repairing it. Persist recovery before waiting: Chromium can abort on crash six (~1.3s after three), ahead of the probe; repair/withdrawal may clear it later. */
async function installDirAclClearsGpuFallback(
  userDataPath: string,
  crashesInWindow: number
): Promise<boolean> {
  if (!installDirAclWithholdsGpuFallback()) {
    return true
  }
  const persisted = persistGpuFallbackMarker(userDataPath, {
    engagedAt: Date.now(),
    crashesInWindow,
    userConfirmed: false
  })
  await waitForInstallDirAclVerdict()
  if (!installDirAclWithholdsGpuFallback()) {
    return true
  }
  // Keep the marker through pending repair so Chromium-fatal relaunches avoid a hardware crash loop. Do not engage in-process GPU here: sibling-death evidence must survive this launch.
  const repairPending = isInstallDirAclRepairPending()
  if (persisted && !repairPending) {
    clearGpuFallbackMarker(userDataPath)
  }
  // Withholding consumes the latched threshold report; re-arm recovery for later driver bursts after repair.
  state.gpuCrashFallbackTracker.disengage()
  recordDurableCrashBreadcrumb('gpu_fallback_withheld_install_dir_acl', {
    crashesInWindow,
    markerHeldForPendingRepair: repairPending
  })
  return false
}

export async function handleGpuChildCrash(
  reason: string,
  exitCode: number | null,
  crashedAt: number
): Promise<void> {
  if (state.gpuFallbackActiveThisLaunch || state.isQuitting || state.isServeMode) {
    return
  }
  // Count crashes before the ACL verdict: it decides recovery, never whether a driver burst happened.
  const result = state.gpuCrashFallbackTracker.recordGpuCrash(crashedAt)
  if (!result.shouldEngageFallback) {
    return
  }
  const fallbackData = { processReason: reason, exitCode, crashesInWindow: result.crashesInWindow }
  const userDataPath = app.getPath('userData')
  if (!(await installDirAclClearsGpuFallback(userDataPath, result.crashesInWindow))) {
    return
  }
  // Recheck after verdict wait so a quit begun meanwhile cannot trigger a modal/relaunch.
  if (state.isQuitting) {
    return
  }
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
