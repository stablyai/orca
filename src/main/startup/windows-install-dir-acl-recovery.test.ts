import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest
} from './windows-install-dir-acl-probe'
import {
  describeInstallDirAclPoison,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'
import {
  ALL_PACKAGES_ACE,
  fakeIcaclsSpawn,
  FRENCH_BASELINE_ACES,
  FRENCH_RESTRICTED_PACKAGES_ACE,
  icaclsDacl,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const APP_VERSION = '1.4.184'

/**
 * Drives the production path: the real probe hands its verdict to the real gate,
 * which decides whether icacls ever runs. Only the two process seams are faked.
 */
function probeThenRecover(
  dacl: (target: string) => string,
  options: { failRepair?: boolean } = {}
): Promise<ProcessSpec[]> {
  const specs: ProcessSpec[] = []
  const runProcessFn = async (spec: ProcessSpec): Promise<ProcessResult> => {
    specs.push(spec)
    return {
      code: options.failRepair === true ? 5 : 0,
      signal: null,
      stdout: 'Successfully processed 81 files; Failed processing 0 files',
      stderr: '',
      timedOut: false
    }
  }
  return new Promise((resolve) => {
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      fileExists: (path) => path.endsWith('ffmpeg.dll'),
      spawnFn: fakeIcaclsSpawn(dacl).spawnFn,
      recordBreadcrumb: () => undefined,
      onDone: (data) => {
        startWindowsInstallDirAclRepairIfPoisoned(data, {
          platform: 'win32',
          installDir: INSTALL_DIR,
          appVersion: APP_VERSION,
          userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
          runProcessFn: runProcessFn as never,
          recordBreadcrumb: () => undefined
        })
        // Longer than the repair's own setImmediate hop, so a repair that was
        // started has always spawned by the time this resolves.
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
    const specs = await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]))
    expect(specs.map((spec) => spec.args?.[2])).toEqual([
      '*S-1-15-2-2:(OI)(CI)(RX)',
      '*S-1-15-2-2:(RX)'
    ])
  })

  // Orphan + the Program Files ALL APPLICATION PACKAGES default launched clean on
  // win32 10.0.26200 / Electron 43.4.1, so it earns neither an ACL write nor the
  // accusing dialog copy.
  it('leaves an install whose package grant is ALL APPLICATION PACKAGES alone', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, ALL_PACKAGES_ACE])
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not touch an install that already carries the restricted grant', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, RESTRICTED_PACKAGES_ACE])
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  // A localized icacls prints the grant under a name the probe cannot match, so
  // the signature is unproven: neither icacls nor the accusing dialog copy.
  it('does not act on a signature from a non-English icacls', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, FRENCH_RESTRICTED_PACKAGES_ACE], FRENCH_BASELINE_ACES)
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not act when the probe could not read the DACL', async () => {
    const specs = await new Promise<ProcessSpec[]>((resolve) => {
      const collected: ProcessSpec[] = []
      probeWindowsInstallDirAcl({
        platform: 'win32',
        installDir: INSTALL_DIR,
        fileExists: () => false,
        spawnFn: fakeIcaclsSpawn(() => null).spawnFn,
        recordBreadcrumb: () => undefined,
        onDone: (data) => {
          startWindowsInstallDirAclRepairIfPoisoned(data, {
            platform: 'win32',
            installDir: INSTALL_DIR,
            appVersion: APP_VERSION,
            userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
            runProcessFn: (async (spec: ProcessSpec) => {
              collected.push(spec)
              throw new Error('unreachable')
            }) as never,
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
    await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]))
    const repaired = describeInstallDirAclPoison()
    expect(repaired?.detail).toContain('Orca repaired the permissions')
    expect(repaired?.detail).not.toContain('Administrator Command Prompt')
    expect(repaired?.commands).toEqual([
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`,
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`
    ])
  })

  it('walks a standard user through icacls when the repair could not write', async () => {
    await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]), {
      failRepair: true
    })
    const failed = describeInstallDirAclPoison()
    expect(failed?.detail).toContain('needs an administrator')
    expect(failed?.detail).toContain(`icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`)
  })

  it('reports the repair as in flight before icacls has answered', () => {
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
      {
        platform: 'win32',
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
        runProcessFn: (() => new Promise<never>(() => undefined)) as never,
        recordBreadcrumb: () => undefined
      }
    )
    expect(describeInstallDirAclPoison()?.detail).toContain('repairing the permissions now')
  })
})
