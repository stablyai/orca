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
import {
  isInstallDirAclRepairExhausted,
  isInstallDirAclRepairPending,
  isInstallDirAclSuspect,
  waitForInstallDirAclVerdict
} from './windows-install-dir-acl-recovery'
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
  // The marker was read before whenReady; the pre-window ACL gate can have retired it since.
  // Asking then would let a "keep it" answer pin software rendering on a machine Orca just fixed.
  if (!readActiveGpuFallbackMarker(userDataPath, gpuFallbackEnvironment())) {
    return
  }
  // The symmetric case: while the tree, not the driver, is on trial (a failed gate leaves it
  // a live suspect), a "keep it" answer would pin a userConfirmed marker no later repair may
  // clear — on the window the poison keeps blank. Staying silent leaves the marker
  // unconfirmed, which a successful repair still retires.
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

/**
 * Why withholding ends with the repair budget: withholding only buys the ACL repair the
 * chance to land first. Once its attempts are spent no repair is coming on this launch or
 * any later one, so holding safe graphics back forever would deny the only recovery left —
 * on a genuinely poisoned tree Orca has already told the user the admin commands, and the
 * probe's flag-blind ACE match also over-matches healthy installs whose driver really is
 * the fault. It is a bounded delay, not a permanent suppression.
 */
function installDirAclWithholdsGpuFallback(): boolean {
  return isInstallDirAclSuspect() && !isInstallDirAclRepairExhausted()
}

/**
 * Why: a poisoned install DACL kills the GPU child exactly like a bad driver, but safe
 * graphics does not rescue it and --in-process-gpu removes the GPU child, erasing the
 * sibling deaths that identify the real cause.
 *
 * Why the marker is written before the wait rather than after: Chromium aborts the whole
 * browser process on the 6th GPU crash, ~1.3s after the 3rd — less than the probe takes
 * to answer — so a machine that dies waiting must still come back software-rendered.
 * The withdrawal below, and the repair's own clear of an unconfirmed marker, undo it.
 */
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
  // Why the marker survives a pending repair: withdrawing it here left a machine that
  // Chromium FATALs mid-repair (crash 6 lands ~1.3s after crash 3, well inside the gate)
  // relaunching hardware accelerated into the same 20s gate, spawning the same GPU children,
  // FATALing again — with no attempt spent, so the loop never advances. Keeping it costs a
  // healthy machine nothing: a successful repair clears an unconfirmed marker itself, and a
  // clean probe reading means we never reach here. It is still not *engaged* this launch, so
  // --in-process-gpu does not erase the sibling-death evidence on the launch that is running.
  const repairPending = isInstallDirAclRepairPending()
  if (persisted && !repairPending) {
    clearGpuFallbackMarker(userDataPath)
  }
  // Why re-arm: recordGpuCrash reports the threshold crossing once and latches. Withholding
  // consumed that one report, so without this a later burst — including one after the repair
  // succeeds and the tree is no longer the suspect — could never engage safe graphics again.
  state.gpuCrashFallbackTracker.disengage()
  recordDurableCrashBreadcrumb('gpu_fallback_withheld_install_dir_acl', {
    crashesInWindow,
    markerHeldForPendingRepair: repairPending
  })
  return false
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
  // Recorded before any install-DACL consideration: the verdict decides whether safe
  // graphics is the right answer, never whether the crash happened. Dropping it here
  // would erase a real driver burst from the rolling window on healthy machines too.
  const result = state.gpuCrashFallbackTracker.recordGpuCrash(crashedAt)
  if (!result.shouldEngageFallback) {
    return
  }
  const fallbackData = { processReason: reason, exitCode, crashesInWindow: result.crashesInWindow }
  const userDataPath = app.getPath('userData')
  if (!(await installDirAclClearsGpuFallback(userDataPath, result.crashesInWindow))) {
    return
  }
  // Re-read after that wait: it can span the probe's whole grace window, and a quit that
  // started inside it must not be answered with a modal and a relaunch.
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
