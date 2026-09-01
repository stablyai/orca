import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import {
  buildInstallDirAclRepairCommands,
  isInstallDirAclPoisonVerdict,
  repairWindowsInstallDirPackageAcl,
  resetWindowsInstallDirAclRepairForTest,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
  type WindowsInstallDirAclRepairResult
} from './windows-install-dir-package-acl-repair'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const APP_VERSION = '1.4.184'

/** icacls' real success summary; the /T pass prints one per tree. */
function icaclsOutput(processed: number, failed: number): string {
  return `Successfully processed ${processed} files; Failed processing ${failed} files`
}

type Runner = (spec: ProcessSpec) => Promise<ProcessResult>

function fakeRunner(reply: (spec: ProcessSpec) => Partial<ProcessResult> = () => ({})): {
  run: Runner
  specs: ProcessSpec[]
} {
  const specs: ProcessSpec[] = []
  const run: Runner = async (spec) => {
    specs.push(spec)
    return {
      code: 0,
      signal: null,
      stdout: icaclsOutput(81, 0),
      stderr: '',
      timedOut: false,
      ...reply(spec)
    }
  }
  return { run, specs }
}

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-acl-repair-'))
}

function repair(
  overrides: {
    userDataPath?: string
    appVersion?: string
    installDir?: string
    platform?: NodeJS.Platform
    isServeMode?: boolean
    run?: Runner
  } = {}
): Promise<{
  result: WindowsInstallDirAclRepairResult
  data: CrashReportBreadcrumbData
}> {
  const { run, ...rest } = overrides
  return new Promise((resolve, reject) => {
    let data: CrashReportBreadcrumbData = {}
    repairWindowsInstallDirPackageAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      ...rest,
      userDataPath: rest.userDataPath ?? userDataDir(),
      runProcessFn: (run ?? fakeRunner().run) as never,
      recordBreadcrumb: (name, breadcrumb) => {
        expect(name).toBe(WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB)
        data = breadcrumb ?? {}
        return undefined
      },
      onDone: (result) => resolve({ result, data })
    })
    setTimeout(() => reject(new Error('repair never settled')), 2_000).unref?.()
  })
}

describe('repairWindowsInstallDirPackageAcl', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclRepairForTest()
  })

  it('grants the flagless (RX) on the recursive pass, never (OI)(CI)(RX)', async () => {
    // The whole fix: icacls silently no-ops an inheritance-flagged grant against a
    // FILE — it exits 0 and reports zero failures while writing no ACE, so the
    // shipped modules stay unreadable and every renderer still dies at init.
    const { run, specs } = fakeRunner()
    await repair({ run })

    const treePass = specs.find((spec) => spec.args?.includes('/T'))
    expect(treePass?.args).toEqual([INSTALL_DIR, '/grant', '*S-1-15-2-2:(RX)', '/T', '/C'])
    expect(treePass?.args).not.toContain('*S-1-15-2-2:(OI)(CI)(RX)')
  })

  it('grants the inheritable (OI)(CI)(RX) on the root, without /T', async () => {
    const { run, specs } = fakeRunner()
    await repair({ run })

    const rootPass = specs.find((spec) => !spec.args?.includes('/T'))
    expect(rootPass?.args).toEqual([INSTALL_DIR, '/grant', '*S-1-15-2-2:(OI)(CI)(RX)'])
    expect(specs).toHaveLength(2)
  })

  it('is additive on every pass so SYSTEM, Administrators and the orphan survive', async () => {
    const { run, specs } = fakeRunner()
    await repair({ run })

    for (const spec of specs) {
      expect(spec.args).toContain('/grant')
      expect(spec.args).not.toContain('/grant:r')
    }
  })

  it('reports the repair and records an ok breadcrumb', async () => {
    const { result, data } = await repair()
    expect(result).toEqual({ mode: 'repaired' })
    expect(data.status).toBe('ok')
    expect(data.failedFileCount).toBe(0)
  })

  it('runs once and then never spawns again for the same install and version', async () => {
    const userDataPath = userDataDir()
    const first = fakeRunner()
    await repair({ userDataPath, run: first.run })
    expect(first.specs).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    const second = fakeRunner()
    const { result, data } = await repair({ userDataPath, run: second.run })
    expect(second.specs).toHaveLength(0)
    expect(result).toEqual({ mode: 'marker-hit' })
    expect(data.reason).toBe('marker-hit')
  })

  it('re-runs after an update and after a reinstall to another directory', async () => {
    const userDataPath = userDataDir()
    await repair({ userDataPath })

    resetWindowsInstallDirAclRepairForTest()
    const updated = fakeRunner()
    expect(
      (await repair({ userDataPath, appVersion: '1.4.185', run: updated.run })).result
    ).toEqual({ mode: 'repaired' })
    expect(updated.specs).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    const moved = fakeRunner()
    expect(
      (
        await repair({
          userDataPath,
          installDir: 'D:\\Program Files\\Orca',
          run: moved.run
        })
      ).result
    ).toEqual({ mode: 'repaired' })
    expect(moved.specs).toHaveLength(2)
  })

  it('re-runs when the marker is from an older scheme or is corrupt', async () => {
    const userDataPath = userDataDir()
    const markerFile = join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE)
    writeFileSync(
      markerFile,
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION - 1,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION
      })
    )
    const stale = fakeRunner()
    await repair({ userDataPath, run: stale.run })
    expect(stale.specs).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    writeFileSync(markerFile, '{ not json')
    const corrupt = fakeRunner()
    await repair({ userDataPath, run: corrupt.run })
    expect(corrupt.specs).toHaveLength(2)
  })

  it('records the failed-file count when a standard user cannot write the ACL', async () => {
    // Program Files: /C keeps going, icacls reports the losses and exits non-zero.
    const { run, specs } = fakeRunner((spec) =>
      spec.args?.includes('/T')
        ? {
            code: 1332,
            stdout: icaclsOutput(0, 81),
            stderr: 'Access is denied.'
          }
        : { code: 5, stdout: '', stderr: 'Access is denied.' }
    )
    const { result, data } = await repair({ run })

    expect(result.mode).toBe('failed')
    expect(data.status).toBe('failed')
    expect(data.failedFileCount).toBe(81)
    // No retry loop: exactly the two passes, then it gives up for this version.
    expect(specs).toHaveLength(2)
  })

  it('still runs the per-file pass when the root grant fails', async () => {
    const { run, specs } = fakeRunner((spec) =>
      spec.args?.includes('/T') ? {} : { code: 5, stderr: 'Access is denied.' }
    )
    const { result } = await repair({ run })
    expect(specs).toHaveLength(2)
    expect(result.mode).toBe('failed')
  })

  it('does not throw when the runner rejects, and still records a breadcrumb', async () => {
    const run: Runner = () => Promise.reject(new Error('spawn EPERM'))
    const { result, data } = await repair({ run })
    expect(result.mode).toBe('failed')
    expect(data.status).toBe('failed')
    expect(String(data.reason)).toContain('spawn EPERM')
  })

  it('marks the attempt so a hopeless install does not re-spawn icacls every launch', async () => {
    const userDataPath = userDataDir()
    await repair({ userDataPath, run: fakeRunner(() => ({ code: 5 })).run })

    const marker = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE), 'utf-8')
    ) as { outcome: string }
    expect(marker.outcome).toBe('failed')
  })

  it('is a no-op off win32 and in serve mode', async () => {
    const off = fakeRunner()
    repairWindowsInstallDirPackageAcl({
      platform: 'darwin',
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      userDataPath: userDataDir(),
      runProcessFn: off.run as never,
      recordBreadcrumb: vi.fn(),
      onDone: () => expect.unreachable('no-op must not settle')
    })
    resetWindowsInstallDirAclRepairForTest()
    const serve = fakeRunner()
    const recordServe = vi.fn()
    repairWindowsInstallDirPackageAcl({
      platform: 'win32',
      isServeMode: true,
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      userDataPath: userDataDir(),
      runProcessFn: serve.run as never,
      recordBreadcrumb: recordServe,
      onDone: () => expect.unreachable('no-op must not settle')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(off.specs).toHaveLength(0)
    expect(serve.specs).toHaveLength(0)
    expect(recordServe).not.toHaveBeenCalled()
  })

  it('offers commands that match what the repair itself runs', () => {
    expect(buildInstallDirAclRepairCommands(INSTALL_DIR)).toEqual([
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`,
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`
    ])
  })
})

describe('isInstallDirAclPoisonVerdict', () => {
  it('only accepts the probe verdict that reproduced the crash', () => {
    expect(
      isInstallDirAclPoisonVerdict({
        status: 'ok',
        matchesPoisonSignature: true,
        wellKnownNameCheckReliable: true
      })
    ).toBe(true)
    expect(
      isInstallDirAclPoisonVerdict({
        status: 'ok',
        matchesPoisonSignature: false
      })
    ).toBe(false)
    expect(isInstallDirAclPoisonVerdict({ status: 'failed', reason: 'unreadable' })).toBe(false)
  })

  // A localized icacls hides the well-known grants behind translated names, so the
  // signature there is unproven: repairing and blaming the install would be wrong.
  it('refuses a signature the probe could not name-check', () => {
    expect(
      isInstallDirAclPoisonVerdict({
        status: 'ok',
        matchesPoisonSignature: true,
        wellKnownNameCheckReliable: false
      })
    ).toBe(false)
  })
})
