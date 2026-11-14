import { mkdtempSync } from 'node:fs'
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

import { grantsFrom } from '../windows-install-permissions/windows-install-dir-acl.test-fixture'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from '../../crash-reporting/recovery/gpu-crash-fallback-decision'
import { readGpuFallbackMarker } from './gpu-fallback-marker'
import { handleGpuChildCrash } from './gpu-lifecycle'
import { mainProcessState as state } from '../main-process-state'
import '../windows-install-permissions/windows-install-dir-acl-poison-marker'
import {
  isInstallDirAclRepairPending,
  noteWindowsInstallDirAclProbePending,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned
} from '../windows-install-permissions/windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from '../windows-install-permissions/windows-install-dir-package-acl-repair'

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

  // Withholding consumes a latched threshold report; re-arm so a repaired tree can recover from later driver crashes.
})

// The pre-window gate may retire an earlier-read marker; asking afterward can permanently pin healthy hardware to software.
