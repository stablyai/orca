import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWindowsSecurityLoadForTests } from '../../shared/windows-security-addon'

import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { readActiveGpuFallbackMarker, writeGpuFallbackMarker } from './gpu-fallback-marker'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest
} from './windows-install-dir-acl-probe'
import {
  hasInstallDirAclPoisonMarker,
  writeInstallDirAclPoisonMarker
} from './windows-install-dir-acl-poison-marker'
import {
  describeInstallDirAclPoison,
  isBlockingInstallDirAclRepairInFlight,
  isInstallDirAclRepairExhausted,
  isInstallDirAclSuspect,
  noteWindowsInstallDirAclProbePending,
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned,
  type WindowsInstallDirAclRecoveryOptions
} from './windows-install-dir-acl-recovery'
import {
  resetWindowsInstallDirAclRepairForTest,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION
} from './windows-install-dir-package-acl-repair'
import type { InstallDirPackageGrantOutcome } from './windows-install-dir-package-acl-grant'
import {
  ALL_PACKAGES_ACE,
  grantsFrom,
  installFakeDacls,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE,
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

/** Keep probe-to-gate decisions real; fake only DACL reads and grants. */
function probeThenRecover(
  savedAces: (target: string) => string[],
  options: { failRepair?: boolean } = {}
): Promise<InstallDirPackageGrantPass[]> {
  const specs: InstallDirPackageGrantPass[] = []
  const grantFn: Runner = async (_installDir, pass) => {
    specs.push(pass)
    return options.failRepair === true ? DENIED : OK
  }
  installFakeDacls(savedAces)
  return new Promise((resolve) => {
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      fileExists: (path) => path.endsWith('ffmpeg.dll'),
      recordBreadcrumb: () => undefined,
      onDone: (data) => {
        startWindowsInstallDirAclRepairIfPoisoned(data, {
          platform: 'win32',
          installDir: INSTALL_DIR,
          appVersion: APP_VERSION,
          userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
          grants: grantsFrom(grantFn),
          recordBreadcrumb: () => undefined
        })
        // Wait past the repair's deferred grant hop before asserting.
        setTimeout(() => resolve(specs), 25)
      }
    })
  })
}

describe('startWindowsInstallDirAclRepairIfPoisoned', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('repairs when the probe sees an orphan package ACE and no well-known grant', async () => {
    const specs = await probeThenRecover(() => [ORPHAN_PACKAGE_ACE])
    expect(specs).toEqual(['root', 'tree'])
  })

  // ALL APPLICATION PACKAGES launched clean with an orphan on Windows 10.0.26200/Electron 43.4.1; require no repair or accusation.
  it('leaves an install whose package grant is ALL APPLICATION PACKAGES alone', async () => {
    const specs = await probeThenRecover(() => [ORPHAN_PACKAGE_ACE, ALL_PACKAGES_ACE])
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not touch an install that already carries the restricted grant', async () => {
    const specs = await probeThenRecover(() => [ORPHAN_PACKAGE_ACE, RESTRICTED_PACKAGES_ACE])
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not act when the probe could not read the DACL', async () => {
    installFakeDacls(() => null)
    const specs = await new Promise<InstallDirPackageGrantPass[]>((resolve) => {
      const collected: InstallDirPackageGrantPass[] = []
      probeWindowsInstallDirAcl({
        platform: 'win32',
        installDir: INSTALL_DIR,
        fileExists: () => false,
        recordBreadcrumb: () => undefined,
        onDone: (data) => {
          startWindowsInstallDirAclRepairIfPoisoned(data, {
            platform: 'win32',
            installDir: INSTALL_DIR,
            appVersion: APP_VERSION,
            userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
            grants: grantsFrom(async (_installDir, pass) => {
              collected.push(pass)
              throw new Error('unreachable')
            }),
            recordBreadcrumb: () => undefined
          })
          setTimeout(() => resolve(collected), 25)
        }
      })
    })
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })
})

describe('describeInstallDirAclPoison', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('offers the copyable commands, and drops them once the repair lands', async () => {
    await probeThenRecover(() => [ORPHAN_PACKAGE_ACE])
    const repaired = describeInstallDirAclPoison()
    expect(repaired?.detail).toContain('Orca repaired the permissions')
    expect(repaired?.detail).not.toContain('Administrator Command Prompt')
    expect(repaired?.commands).toEqual([
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`,
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`
    ])
  })

  it('walks a standard user through icacls when the repair could not write', async () => {
    await probeThenRecover(() => [ORPHAN_PACKAGE_ACE], {
      failRepair: true
    })
    const failed = describeInstallDirAclPoison()
    expect(failed?.detail).toContain('needs an administrator')
    expect(failed?.detail).toContain(`icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`)
  })

  it('reports the repair as in flight before the grant has answered', () => {
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: true },
      {
        platform: 'win32',
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
        grants: grantsFrom(() => new Promise<never>(() => undefined)),
        recordBreadcrumb: () => undefined
      }
    )
    expect(describeInstallDirAclPoison()?.detail).toContain('repairing the permissions now')
  })
})

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

describe('install-dir ACL repair vs the GPU safe-graphics marker', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('clears the sticky safe-graphics marker once the real cause is repaired', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-'))
    // Model poisoned-DACL GPU deaths that engaged the build's safe-graphics latch.
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).not.toBeNull()

    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, okRun),
        // Wait for both deferred grant passes.
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(describeInstallDirAclPoison()?.detail).toContain('repaired the permissions')
    // Successful ACL repair must retire unconfirmed safe graphics, which hides future sibling-death evidence.
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()
  })

  // Preserve user-confirmed safe graphics; only Orca's automatic latch may be retired.
  it('leaves a user-confirmed safe-graphics marker alone', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-'))
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: true },
      GPU_ENV
    )

    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, okRun),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(describeInstallDirAclPoison()?.detail).toContain('repaired the permissions')
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)?.userConfirmed).toBe(true)
  })
})

describe('isInstallDirAclSuspect', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('is false when nothing has suggested the install DACL is involved', () => {
    expect(isInstallDirAclSuspect()).toBe(false)
  })

  // GPU deaths can precede the probe by seconds; pending verdict is the misdiagnosis window.
  it('holds while the probe verdict is outstanding, and releases on a clean verdict', () => {
    noteWindowsInstallDirAclProbePending()
    expect(isInstallDirAclSuspect()).toBe(true)

    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-suspect-')), okRun)
    )
    expect(isInstallDirAclSuspect()).toBe(false)
  })

  it('releases once the wait exceeds the grace window, so a silent probe cannot pin it', () => {
    noteWindowsInstallDirAclProbePending()
    expect(isInstallDirAclSuspect(Date.now() + 14_000)).toBe(true)
    expect(isInstallDirAclSuspect(Date.now() + 16_000)).toBe(false)
  })

  it('holds through a repair that failed, and releases once one succeeds', async () => {
    const failing: Runner = async () => DENIED
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-suspect-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, failing)
    )
    expect(isInstallDirAclSuspect()).toBe(true)
    await vi.waitFor(() => expect(describeInstallDirAclPoison()?.detail).toContain('could not'))
    expect(isInstallDirAclSuspect()).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-suspect-')), okRun)
    )
    await vi.waitFor(() => expect(isInstallDirAclSuspect()).toBe(false))
  })
})

describe('repairKnownPoisonedInstallDirBeforeWindow', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('costs a healthy machine one absent-file read and no grant', async () => {
    const specs: InstallDirPackageGrantPass[] = []
    const run: Runner = async (_installDir, pass) => {
      specs.push(pass)
      return OK
    }
    const mode = await repairKnownPoisonedInstallDirBeforeWindow(
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-gate-')), run)
    )
    expect(mode).toBe('not-marked')
    expect(specs).toHaveLength(0)
  })

  // Persisted poison must repair before launch-two window creation; launch one's deferred probe was too late.
  it('repairs a launch that a previous one recorded as poisoned, before returning', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    // First launch dies after recording poison but before repair completes.
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )
    const specs: InstallDirPackageGrantPass[] = []
    const run: Runner = async (_installDir, pass) => {
      specs.push(pass)
      return OK
    }
    const mode = await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, run))
    expect(mode).toBe('repaired')
    expect(specs).toEqual(['root', 'tree'])
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()
  })

  it('gives up on its budget rather than holding the window open forever', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, () => new Promise<never>(() => undefined)),
      timeoutMs: 20
    })
    expect(mode).toBe('timeout')
  })

  it('is a no-op off win32 and in serve mode', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    expect(
      await repairKnownPoisonedInstallDirBeforeWindow({
        ...recoveryOptions(userDataPath, okRun),
        platform: 'darwin'
      })
    ).toBe('skipped')
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow({
        ...recoveryOptions(userDataPath, okRun),
        isServeMode: true
      })
    ).toBe('skipped')
  })

  it('retires the marker when a later probe reports the install clean', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)
  })

  // Unreadable DACL cannot retire poison evidence or the next launch repeats a known crash.
  it('keeps the marker when the probe could not read the DACL', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    resetWindowsInstallDirAclRecoveryForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'failed', reason: 'all-targets-unreadable' },
      recoveryOptions(userDataPath, okRun)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })

  // A 20s gate can time out before its 120s grant. Later poison readings outrank that grant's success claim or it falsely disarms recovery and enables in-process GPU.
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

  // Reverse ordering: a later poison reading must restore safe graphics already cleared by the grant's disproved success claim.
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
})

// With outstanding poison evidence, a completed-repair marker proves no current health; marker-hit means spent budget only.
describe('a repair marker recording a completed repair', () => {
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

  // Three-launch regression: old successful repair, re-poisoning/crash mid-repair, then poison plus stale-success markers. The third gate must grant again within budget.
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

  // Spent budget must report unrepaired, without falsely clearing poison.
  it('does not let the gate report a spent budget as a repair', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-budget-'))
    writeFileSync(
      join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        attemptedAt: Date.now(),
        outcome: 'repaired',
        attempts: 3
      })
    )
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    const spent: InstallDirPackageGrantPass[] = []
    const mode = await gateLaunch(userDataPath, async (_installDir, pass) => {
      spent.push(pass)
      return OK
    })
    expect(mode).toBe('marker-hit')
    expect(spent).toHaveLength(0)
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(isInstallDirAclRepairExhausted()).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })

  // A later probe reading outranks gate success if the tree still matches poison.
  it('is overruled by a probe that reads the tree poisoned after the gate repaired it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-noop-grant-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')

    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))

    expect(isInstallDirAclSuspect()).toBe(true)
    expect(isInstallDirAclRepairExhausted()).toBe(false)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })

  // Gate success is provisional until probe/grace expiry: child deaths can precede the probe, and early in-process GPU would hide evidence.
  it('keeps a gate-repaired tree suspect until this launch probe has read it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-provisional-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')

    // Model window creation dispatching a still-pending probe.
    noteWindowsInstallDirAclProbePending()
    expect(isInstallDirAclSuspect()).toBe(true)
    // Probe timeout bounds suspicion when no reading arrives.
    expect(isInstallDirAclSuspect(Date.now() + 15_000)).toBe(false)

    // A clean reading corroborates repair and releases immediately.
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    expect(isInstallDirAclSuspect()).toBe(false)
  })

  // Disproved repair must restore cleared safe graphics or hardware relaunch can abort before the re-armed gate repairs.
  it('restores the safe-graphics marker a disproved repair claim cleared', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-restore-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()

    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))

    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)?.userConfirmed).toBe(false)
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })

  // Fresh poison evidence contradicts prior success; rerun within budget rather than disarm the gate or claim repaired permissions.
  it('re-runs the grant when a fresh probe verdict contradicts the repaired marker', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repoisoned-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')

    // Next launch re-probes poison after the old repair disarmed the gate.
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    const spent: InstallDirPackageGrantPass[] = []
    const failing: Runner = async (_installDir, pass) => {
      spent.push(pass)
      return DENIED
    }
    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, failing),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(spent).toEqual(['root', 'tree'])
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
  })

  // New poison evidence cannot remove the attempt cap or every launch would re-walk permanently broken trees.
  it('still stops at the attempt budget when the probe keeps reporting poison', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repoisoned-budget-'))
    writeFileSync(
      join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        attemptedAt: Date.now(),
        outcome: 'repaired',
        attempts: 3
      })
    )
    const spent: InstallDirPackageGrantPass[] = []
    const run: Runner = async (_installDir, pass) => {
      spent.push(pass)
      return OK
    }
    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, run),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(spent).toHaveLength(0)
    // Unrepaired trees retain commands and next-launch gating.
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })
})

describe('a clean probe verdict', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  // A clean probe retires suspicion even after the gate exhausted its repair budget.
  it('retires a verdict the gate could no longer act on', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-clean-'))
    writeFileSync(
      join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        attemptedAt: Date.now(),
        outcome: 'failed',
        attempts: 3
      })
    )
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('marker-hit')
    expect(isInstallDirAclSuspect()).toBe(true)

    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  // A clean reading outranks a later failed repair result about a tree with nothing left to fix.
  it('outranks a repair verdict that lands after it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-clean-'))
    const failing: Runner = async () => DENIED
    let repairSettled = false
    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
      ...recoveryOptions(userDataPath, failing),
      recordBreadcrumb: () => {
        repairSettled = true
        return undefined
      }
    })
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    await vi.waitFor(() => expect(repairSettled).toBe(true))
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(describeInstallDirAclPoison()).toBeNull()
  })
})

describe('the probe-pending grace window', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  // Reopen must not re-arm the once-per-process probe wait and suppress real GPU recovery for another 15s.
  it('is armed by a dispatched probe only, so a reopen cannot re-arm it', async () => {
    installFakeDacls(() => [RESTRICTED_PACKAGES_ACE])
    const probeArgs = {
      platform: 'win32' as const,
      installDir: INSTALL_DIR,
      fileExists: () => false,
      recordBreadcrumb: () => undefined
    }
    let settleVerdict: () => void = () => undefined
    const verdict = new Promise<void>((resolve) => (settleVerdict = resolve))
    // Use the same dispatch-gated arming as window startup.
    const dispatched = probeWindowsInstallDirAcl({
      ...probeArgs,
      onDone: (data) => {
        startWindowsInstallDirAclRepairIfPoisoned(
          data,
          recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-rearm-')), okRun)
        )
        settleVerdict()
      }
    })
    if (dispatched) {
      noteWindowsInstallDirAclProbePending()
    }
    expect(dispatched).toBe(true)
    expect(isInstallDirAclSuspect()).toBe(true)
    await verdict
    expect(isInstallDirAclSuspect()).toBe(false)

    // Reopen: the probe declines, so nothing arms the grace window again.
    const reopened = probeWindowsInstallDirAcl({ ...probeArgs, onDone: () => undefined })
    if (reopened) {
      noteWindowsInstallDirAclProbePending()
    }
    expect(reopened).toBe(false)
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(isInstallDirAclSuspect(Date.now() + 14_000)).toBe(false)
  })
})

describe('isBlockingInstallDirAclRepairInFlight', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('is false on a healthy machine and clears once the gate returns', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-inflight-'))
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)

    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, () => new Promise<never>(() => undefined))
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    let inFlightDuringRepair = false
    const gate = repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, async () => {
        inFlightDuringRepair = isBlockingInstallDirAclRepairInFlight()
        return OK
      }),
      timeoutMs: 5_000
    })
    expect(await gate).toBe('repaired')
    expect(inFlightDuringRepair).toBe(true)
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)
  })

  // A second entry has no `onDone` coming, so waiting out the 20s budget for it
  // would hold the window closed for nothing.
  it('returns immediately when the once-per-process repair already ran', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-inflight-'))
    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))
    resetWindowsInstallDirAclRecoveryForTest()

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, okRun),
      timeoutMs: 30_000
    })
    expect(mode).toBe('skipped')
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)
  })
})

afterEach(() => {
  resetWindowsSecurityLoadForTests()
})
