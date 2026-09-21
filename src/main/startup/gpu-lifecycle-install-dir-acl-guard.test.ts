import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted with the vi.mock factory below. 'Keep Running' — the prompt firing at all is the signal.
const { showMessageBox, userData } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  userData: { path: '' }
}))

// Why the mocks: gpu-lifecycle's import graph reaches electron and the toolkit's
// electron re-export. Everything below this is the real module under test.
vi.mock('electron', () => ({
  app: {
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
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() },
  electronApp: { setAppUserModelId: vi.fn() }
}))

import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
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

/** icacls hangs until `finishRepair` — the in-flight window is when the GPU children die. */
function reportProbePoisoned(): { finishRepair: () => Promise<void> } {
  let release = (): void => undefined
  const walkingTheTree = new Promise<void>((resolve) => {
    release = resolve
  })
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
    {
      ...recoveryOptions(),
      runProcessFn: (async () => {
        await walkingTheTree
        return {
          code: 0,
          signal: null,
          stdout: 'Successfully processed 3200 files; Failed processing 0 files',
          stderr: '',
          timedOut: false
        }
      }) as unknown as (spec: ProcessSpec) => Promise<ProcessResult>
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

/** A repair that settles, so `poison.stage` leaves 'pending' for a terminal verdict. */
async function reportProbePoisonedWithSettledRepair(
  exitCode: number,
  userDataPath?: string
): Promise<void> {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
    {
      ...recoveryOptions(userDataPath),
      runProcessFn: (async () => ({
        code: exitCode,
        signal: null,
        stdout: 'Successfully processed 3200 files; Failed processing 0 files',
        stderr: exitCode === 0 ? '' : 'access denied',
        timedOut: false
      })) as unknown as (spec: ProcessSpec) => Promise<ProcessResult>
    }
  )
  for (let i = 0; i < 200 && isInstallDirAclRepairPending(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * The pre-window gate meeting a spent repair budget: the tree is still marked poisoned and
 * Orca has no repair left to try. icacls must never be reached, so the runner throws.
 */
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
    runProcessFn: (() => {
      throw new Error('the spent budget must not spawn icacls')
    }) as never
  })
  expect(mode).toBe('marker-hit')
}

function reportProbeClean(): void {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: false },
    recoveryOptions()
  )
}

/** One short of the fallback threshold, so the caller's next crash is the decisive one. */
async function crashUpToThreshold(): Promise<void> {
  for (let i = 1; i < DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
    await handleGpuChildCrash('crashed', null, i * 200)
  }
}

/**
 * Driven end-to-end against the real tracker rather than asserted against the source:
 * a source match is equally happy with the polarity inverted, and the property that
 * matters is that a driver burst survives the ACL verdict either way.
 */
describe('handleGpuChildCrash vs the install-dir ACL verdict', () => {
  let tracker: GpuCrashFallbackTracker
  const realPlatform = process.platform

  beforeAll(() => {
    // The whole guard is win32-only, and so is the safe-graphics marker it writes.
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

  // The regression this guard must never reintroduce: the probe is armed on every
  // win32 launch, so a burst landing inside its window is the common driver case.
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

  // The gate's 'repaired' is icacls's exit claim, not a reading of the tree, and an icacls
  // that silently no-opped exits 0 on a tree it left poisoned. The GPU children die in the
  // interval before this launch's probe answers, so a claim that un-suspects the tree there
  // engages --in-process-gpu on a tree safe graphics cannot rescue — and a "keep it" answer
  // then pins a userConfirmed marker no later repair may clear.
  it('withholds safe graphics between a gate repair claim and this launch probe reading', async () => {
    writeInstallDirAclPoisonMarker(userData.path, INSTALL_DIR, '1.4.184')
    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userData.path),
      runProcessFn: (async () => ({
        code: 0,
        signal: null,
        stdout: 'Successfully processed 3200 files; Failed processing 0 files',
        stderr: '',
        timedOut: false
      })) as unknown as (spec: ProcessSpec) => Promise<ProcessResult>
    })
    expect(mode).toBe('repaired')
    noteWindowsInstallDirAclProbePending()

    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()

    // The reading lands poisoned: the claim was false, and engagement stays withheld.
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
      recoveryOptions(userData.path)
    )
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Chromium aborts the browser on the 6th GPU crash, sooner than the probe can answer,
  // so the wait must not be the reason a machine comes back hardware-accelerated.
  it('holds an unconfirmed safe-graphics marker on disk across the wait', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
    reportProbePoisoned()
    await decisive
    // The verdict dispatched a repair, so the marker stays for the launch that repair rescues.
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
  })

  it('engages immediately once the probe has already reported the install clean', async () => {
    noteWindowsInstallDirAclProbePending()
    reportProbeClean()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  // Both from the re-run adversarial round. The gate dispatches a repair without arming the
  // probe clock, so `waitForInstallDirAclVerdict` returns immediately and the withdrawal used
  // to delete the marker inside Chromium's ~1.3s FATAL window — leaving the machine to
  // relaunch hardware accelerated into the same 20s gate, forever.
  it('keeps the safe-graphics marker on disk while a repair is still in flight', async () => {
    reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
  })

  it('still withdraws the marker once the verdict is terminal rather than a pending repair', async () => {
    await reportProbePoisonedWithSettledRepair(1)
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)

    expect(showMessageBox).not.toHaveBeenCalled()
    // No repair is in flight to rescue a later launch, so the marker is not held.
    expect(readGpuFallbackMarker(userData.path)).toBeNull()
  })

  // The verdict wait can span the probe's whole 15s grace window, and the entry guard was
  // read before it. A quit that starts inside the wait must not be answered with a modal.
  it('does not prompt when the user quits during the verdict wait', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    state.isQuitting = true
    reportProbeClean()
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Withholding is a bounded delay, not a permanent suppression. Once the repair budget is
  // spent no repair is coming on this launch or any later one, so pinning the tree as the
  // suspect forever denied safe graphics on EVERY launch for the life of that version — and
  // deleted the marker each time, so the machine also relaunched hardware accelerated. The
  // victims are a standard-user install icacls can never fix and, via the probe's flag-blind
  // ACE match, healthy installs whose driver genuinely is broken.
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

  // Still withheld while the budget has an attempt left: the repair is the better answer,
  // and this is the launch a next one can be rescued on.
  it('still withholds while the repair has an attempt left to spend', async () => {
    await reportProbePoisonedWithSettledRepair(1)
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // recordGpuCrash reports the threshold crossing once and latches. Withholding consumes
  // that one report, so without a re-arm the same process could never engage again — a
  // machine whose tree is repaired and whose driver is genuinely broken would be stuck
  // hardware-accelerated through an unbounded crash loop.
  it('can still engage a later burst after a withheld one, once the tree is repaired', async () => {
    const repair = reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()

    // The repair itself reports 'repaired': the tree is no longer the suspect.
    await repair.finishRepair()
    expect(isInstallDirAclRepairPending()).toBe(false)

    for (let i = 1; i <= DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
      await handleGpuChildCrash('crashed', null, 10_000 + i * 200)
    }
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })
})

// The safe-graphics marker is read before whenReady, and the pre-window ACL gate runs after
// that read. Asking "keep safe graphics?" on a machine Orca has just repaired invites a
// `userConfirmed: true` marker that pins software rendering on healthy hardware.
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
    await reportProbePoisonedWithSettledRepair(0, userData.path)
    expect(readGpuFallbackMarker(userData.path)).toBeNull()

    await presentGpuFallbackRecoveredLaunchPrompt(window)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // The symmetric case to the one above: a FAILED repair leaves the marker on disk and the
  // tree a live suspect, the window the prompt lands on is blank, and Keep is both defaultId
  // and cancelId — so asking invites a userConfirmed pin no later repair may clear.
  it('stays silent while the install DACL is still the suspect', async () => {
    await reportProbePoisonedWithSettledRepair(1, userData.path)
    expect(readGpuFallbackMarker(userData.path)).not.toBeNull()

    await presentGpuFallbackRecoveredLaunchPrompt(window)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
