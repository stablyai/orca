import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Any prompt is the signal; answer Keep Running to avoid relaunch.
const { showMessageBox, userData } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  userData: { path: '' }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => userData.path,
    getVersion: () => '1.4.184',
    getGPUFeatureStatus: () => ({}),
    setAboutPanelOptions: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    isReady: () => true,
    exit: vi.fn(),
    on: vi.fn(),
    name: 'Orca'
  },
  dialog: { showMessageBox }
}))

import { grantsFrom } from './windows-install-dir-acl.test-fixture'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from '../crash-reporting/gpu-crash-fallback-decision'
import {
  readGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackMarker
} from './gpu-fallback-marker'
import { handleGpuChildCrash, presentGpuFallbackRecoveredLaunchPrompt } from './gpu-lifecycle'
import { gpuFallbackEnvironment, mainProcessState as state } from './main-process-state'
import { writeInstallDirAclPoisonMarker } from './windows-install-dir-acl-poison-marker'
import {
  isInstallDirAclRepairPending,
  noteWindowsInstallDirAclProbePending,
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned
} from './windows-install-dir-acl-recovery'
import {
  resetWindowsInstallDirAclRepairForTest,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION
} from './windows-install-dir-package-acl-repair'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'

function recoveryOptions(userDataPath?: string): {
  platform: 'win32'
  installDir: string
  appVersion: string
  userDataPath: string
  recordBreadcrumb: () => void
} {
  return {
    platform: 'win32',
    installDir: INSTALL_DIR,
    appVersion: '1.4.184',
    userDataPath: userDataPath ?? mkdtempSync(join(tmpdir(), 'orca-acl-gpu-guard-')),
    recordBreadcrumb: () => undefined
  }
}

/** Keep repair pending through GPU child deaths. */
function reportProbePoisoned(): { finishRepair: () => Promise<void> } {
  let release = (): void => undefined
  const walkingTheTree = new Promise<void>((resolve) => {
    release = resolve
  })
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true },
    {
      ...recoveryOptions(),
      grants: grantsFrom(async () => {
        await walkingTheTree
        return { ok: true, failedFileCount: 0 }
      })
    }
  )
  return {
    finishRepair: async () => {
      release()
      for (let i = 0; i < 200 && isInstallDirAclRepairPending(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
  }
}

async function reportProbePoisonedWithSettledRepair(
  granted: boolean,
  userDataPath?: string
): Promise<void> {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true },
    {
      ...recoveryOptions(userDataPath),
      grants: grantsFrom(async () =>
        granted
          ? { ok: true, failedFileCount: 0 }
          : { ok: false, failedFileCount: 1, reason: 'access denied' }
      )
    }
  )
  for (let i = 0; i < 200 && isInstallDirAclRepairPending(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Exhaust repair budget while the tree stays suspect; any new grant attempt must fail the test. */
async function gateFindsRepairBudgetSpent(): Promise<void> {
  const options = recoveryOptions()
  writeFileSync(
    join(options.userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
    JSON.stringify({
      schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
      installDir: INSTALL_DIR,
      appVersion: options.appVersion,
      attemptedAt: Date.now(),
      outcome: 'failed',
      attempts: 3
    })
  )
  writeInstallDirAclPoisonMarker(options.userDataPath, INSTALL_DIR, options.appVersion)
  const mode = await repairKnownPoisonedInstallDirBeforeWindow({
    ...options,
    grants: grantsFrom(() => {
      throw new Error('the spent budget must not grant')
    })
  })
  expect(mode).toBe('marker-hit')
}

function reportProbeClean(): void {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: false },
    recoveryOptions()
  )
}

async function crashUpToThreshold(): Promise<void> {
  for (let i = 1; i < DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
    await handleGpuChildCrash('crashed', null, i * 200)
  }
}

/** Exercise the real tracker: source matching cannot prove driver bursts survive either ACL verdict. */
describe('handleGpuChildCrash vs the install-dir ACL verdict', () => {
  let tracker: GpuCrashFallbackTracker
  const realPlatform = process.platform

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  beforeEach(() => {
    userData.path = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-userdata-'))
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
    showMessageBox.mockClear()
    state.isQuitting = false
    state.isServeMode = false
    state.gpuFallbackActiveThisLaunch = false
    tracker = new GpuCrashFallbackTracker({
      windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
      threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
    })
    state.gpuCrashFallbackTracker = tracker
  })

  it('engages safe graphics on a driver burst when nothing implicates the install DACL', async () => {
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  // The probe runs every win32 launch; crashes during its pending verdict must still count.
  it('keeps counting crashes that land while the probe verdict is outstanding', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()
    reportProbeClean()
    await decisive
    expect(tracker.windowSnapshot()).toHaveLength(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('withholds safe graphics while the install DACL is the suspect, but keeps the evidence', async () => {
    reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(tracker.windowSnapshot()).toHaveLength(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('withholds safe graphics when the outstanding verdict comes back poisoned', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    reportProbePoisoned()
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // A gate repair claim may be a no-op; only this launch's probe can clear suspicion before user consent permanently pins safe graphics.
  it('withholds safe graphics between a gate repair claim and this launch probe reading', async () => {
    writeInstallDirAclPoisonMarker(userData.path, INSTALL_DIR, '1.4.184')
    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userData.path),
      grants: grantsFrom(async () => ({ ok: true, failedFileCount: 0 }))
    })
    expect(mode).toBe('repaired')
    noteWindowsInstallDirAclProbePending()

    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()

    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: true },
      recoveryOptions(userData.path)
    )
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Chromium can abort on crash six before the probe answers; persist recovery across that wait.
  it('holds an unconfirmed safe-graphics marker on disk across the wait', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
    reportProbePoisoned()
    await decisive
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
  })

  it('engages immediately once the probe has already reported the install clean', async () => {
    noteWindowsInstallDirAclProbePending()
    reportProbeClean()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  // A pending repair without probe clock used to withdraw the marker inside Chromium's fatal window, causing endless hardware relaunches.
  it('keeps the safe-graphics marker on disk while a repair is still in flight', async () => {
    reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
  })

  it('still withdraws the marker once the verdict is terminal rather than a pending repair', async () => {
    await reportProbePoisonedWithSettledRepair(false)
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readGpuFallbackMarker(userData.path)).toBeNull()
  })

  // A quit may begin during the verdict wait; do not answer it with a modal.
  it('does not prompt when the user quits during the verdict wait', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    state.isQuitting = true
    reportProbeClean()
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // After repair attempts are exhausted, indefinite suspicion would deny the remaining recovery on every launch, including false-positive ACL matches.
  it('offers safe graphics on every launch once the ACL repair budget is spent', async () => {
    for (let launch = 1; launch <= 3; launch += 1) {
      resetWindowsInstallDirAclRepairForTest()
      resetWindowsInstallDirAclRecoveryForTest()
      showMessageBox.mockClear()
      state.gpuCrashFallbackTracker = new GpuCrashFallbackTracker({
        windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
        threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
      })
      await gateFindsRepairBudgetSpent()

      await crashUpToThreshold()
      await handleGpuChildCrash('crashed', null, 600)
      expect(showMessageBox).toHaveBeenCalledTimes(1)
    }
  })

  // With attempts remaining, let ACL repair land before safe graphics.
  it('still withholds while the repair has an attempt left to spend', async () => {
    await reportProbePoisonedWithSettledRepair(false)
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Withholding consumes a latched threshold report; re-arm so a repaired tree can recover from later driver crashes.
  it('can still engage a later burst after a withheld one, once the tree is repaired', async () => {
    const repair = reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()

    await repair.finishRepair()
    expect(isInstallDirAclRepairPending()).toBe(false)

    for (let i = 1; i <= DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
      await handleGpuChildCrash('crashed', null, 10_000 + i * 200)
    }
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })
})

// The pre-window gate may retire an earlier-read marker; asking afterward can permanently pin healthy hardware to software.
describe('presentGpuFallbackRecoveredLaunchPrompt vs a marker retired since it was read', () => {
  const realPlatform = process.platform
  const window = { isDestroyed: () => false } as unknown as Parameters<
    typeof presentGpuFallbackRecoveredLaunchPrompt
  >[0]

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  beforeEach(() => {
    userData.path = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-recovered-'))
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
    showMessageBox.mockClear()
    state.isQuitting = false
    const info = { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false }
    writeGpuFallbackMarker(userData.path, info, {
      ...gpuFallbackEnvironment(),
      platform: 'win32'
    })
    state.activeGpuFallbackMarker = readGpuFallbackMarker(userData.path) as GpuFallbackMarker
  })

  it('asks while the marker is still on disk', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await presentGpuFallbackRecoveredLaunchPrompt(window)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('stays silent once the install-DACL repair has cleared it', async () => {
    await reportProbePoisonedWithSettledRepair(true, userData.path)
    expect(readGpuFallbackMarker(userData.path)).toBeNull()

    await presentGpuFallbackRecoveredLaunchPrompt(window)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Failed repair leaves a blank suspect window; default Keep would pin a marker no later repair may clear.
  it('stays silent while the install DACL is still the suspect', async () => {
    await reportProbePoisonedWithSettledRepair(false, userData.path)
    expect(readGpuFallbackMarker(userData.path)).not.toBeNull()

    await presentGpuFallbackRecoveredLaunchPrompt(window)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
