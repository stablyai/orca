import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetWindowsSecurityLoadForTests } from '../../../shared/windows-security-addon'

import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import {
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker
} from '../gpu-recovery/gpu-fallback-marker'
import { resetWindowsInstallDirAclProbeForTest } from './windows-install-dir-acl-probe'
import {
  hasInstallDirAclPoisonMarker,
  writeInstallDirAclPoisonMarker
} from './windows-install-dir-acl-poison-marker'
import {
  describeInstallDirAclPoison,
  isInstallDirAclSuspect,
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned,
  type WindowsInstallDirAclRecoveryOptions
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'
import type { InstallDirPackageGrantOutcome } from './windows-install-dir-package-acl-grant'
import {
  grantsFrom,
  type InstallDirPackageGrant,
  type InstallDirPackageGrantPass
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const APP_VERSION = '1.4.184'

type Runner = InstallDirPackageGrant

const OK: InstallDirPackageGrantOutcome = { ok: true, failedFileCount: 0 }
const DENIED: InstallDirPackageGrantOutcome = {
  ok: false,
  failedFileCount: 1,
  reason: 'Access is denied.'
}

const POISON_VERDICT: CrashReportBreadcrumbData = {
  status: 'ok',
  matchesPoisonSignature: true
}
const GPU_ENV = { appVersion: APP_VERSION, electronVersion: '43.4.1', platform: 'win32' } as const

function recoveryOptions(userDataPath: string, run: Runner): WindowsInstallDirAclRecoveryOptions {
  return {
    platform: 'win32',
    installDir: INSTALL_DIR,
    appVersion: APP_VERSION,
    userDataPath,
    grants: grantsFrom(run),
    recordBreadcrumb: () => undefined
  }
}

const okRun: Runner = async () => OK

describe('install-dir ACL recovery evidence ordering', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  /** Reset process latches between launches while retaining persisted evidence. */
  async function gateLaunch(
    userDataPath: string,
    run: Runner
  ): Promise<Awaited<ReturnType<typeof repairKnownPoisonedInstallDirBeforeWindow>>> {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
    return repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, run))
  }

  it('does not let a timed-out gate repair outrank a poison reading taken after it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-timeout-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )

    let releaseIcacls: () => void = () => undefined
    const stalled = new Promise<void>((resolve) => {
      releaseIcacls = resolve
    })
    let repairReported: () => void = () => undefined
    const reported = new Promise<void>((resolve) => {
      repairReported = resolve
    })

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, async () => {
        await stalled
        return OK
      }),
      recordBreadcrumb: () => {
        setTimeout(repairReported, 0)
        return undefined
      },
      timeoutMs: 20
    })
    expect(mode).toBe('timeout')

    // Probe after window creation supplies newer poison evidence than the still-running grant.
    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    releaseIcacls()
    await reported

    expect(isInstallDirAclSuspect()).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).not.toBeNull()
  })

  it('restores the safe-graphics marker when the probe disproves a timed-out gate repair', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-timeout-restore-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )

    let releaseIcacls: () => void = () => undefined
    const stalled = new Promise<void>((resolve) => {
      releaseIcacls = resolve
    })
    let repairReported: () => void = () => undefined
    const reported = new Promise<void>((resolve) => {
      repairReported = resolve
    })

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, async () => {
        await stalled
        return OK
      }),
      recordBreadcrumb: () => {
        setTimeout(repairReported, 0)
        return undefined
      },
      timeoutMs: 20
    })
    expect(mode).toBe('timeout')

    releaseIcacls()
    await reported
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()

    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))

    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)?.userConfirmed).toBe(false)
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
    expect(isInstallDirAclSuspect()).toBe(true)
  })

  it('re-runs the grant when a poison marker outlives it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repaired-hit-'))

    // First launch repairs and retires poison.
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(await gateLaunch(userDataPath, okRun)).toBe('repaired')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)

    // Second launch dies mid-repair after recording new poison; the old success marker remains.
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    // Third launch must repair rather than trust first-launch success.
    const spent: InstallDirPackageGrantPass[] = []
    const mode = await gateLaunch(userDataPath, async (_installDir, pass) => {
      spent.push(pass)
      return DENIED
    })
    expect(mode).toBe('failed')
    expect(spent).toEqual(['root', 'tree'])
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })
})

afterEach(() => {
  resetWindowsSecurityLoadForTests()
})
