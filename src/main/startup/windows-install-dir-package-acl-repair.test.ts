import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

// Fail any process spawn: repair must use the in-process addon rather than icacls.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

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
import { fakePackageGrant, grantsFrom } from './windows-install-dir-acl.test-fixture'
import type { InstallDirPackageGrants } from './windows-install-dir-package-acl-grant'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const APP_VERSION = '1.4.184'

function deniedGrant(): ReturnType<typeof fakePackageGrant> {
  return fakePackageGrant(() => ({ ok: false, failedFileCount: 1, reason: 'Access is denied.' }))
}

function userDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-acl-repair-'))
  onTestFinished(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function repair(
  overrides: {
    userDataPath?: string
    appVersion?: string
    installDir?: string
    platform?: NodeJS.Platform
    isServeMode?: boolean
    grants?: InstallDirPackageGrants
  } = {}
): Promise<{
  result: WindowsInstallDirAclRepairResult
  data: CrashReportBreadcrumbData
}> {
  const { grants, ...rest } = overrides
  return new Promise((resolve, reject) => {
    let data: CrashReportBreadcrumbData = {}
    repairWindowsInstallDirPackageAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      ...rest,
      userDataPath: rest.userDataPath ?? userDataDir(),
      grants: grants ?? fakePackageGrant().grants,
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
    runProcessMock.mockClear()
    runProcessSyncMock.mockClear()
  })

  it('runs the inheritable root pass, then the per-entry tree pass, on the install dir', async () => {
    const { grants, passes } = fakePackageGrant()
    await repair({ grants })
    expect(passes).toEqual([
      { installDir: INSTALL_DIR, pass: 'root' },
      { installDir: INSTALL_DIR, pass: 'tree' }
    ])
  })

  it('never starts a child process', async () => {
    await repair()
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('reports the repair and records an ok breadcrumb', async () => {
    const { result, data } = await repair()
    expect(result).toEqual({ mode: 'repaired' })
    expect(data.status).toBe('ok')
    expect(data.failedFileCount).toBe(0)
  })

  it('runs once and then never grants again for the same install and version', async () => {
    const userDataPath = userDataDir()
    const first = fakePackageGrant()
    await repair({ userDataPath, grants: first.grants })
    expect(first.passes).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    const second = fakePackageGrant()
    const { result, data } = await repair({ userDataPath, grants: second.grants })
    expect(second.passes).toHaveLength(0)
    expect(result).toEqual({ mode: 'marker-hit', alreadyRepaired: true })
    expect(data.reason).toBe('marker-hit')
  })

  it('re-runs after an update and after a reinstall to another directory', async () => {
    const userDataPath = userDataDir()
    await repair({ userDataPath })

    resetWindowsInstallDirAclRepairForTest()
    const updated = fakePackageGrant()
    expect(
      (await repair({ userDataPath, appVersion: '1.4.185', grants: updated.grants })).result
    ).toEqual({ mode: 'repaired' })
    expect(updated.passes).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    const moved = fakePackageGrant()
    expect(
      (
        await repair({
          userDataPath,
          installDir: 'D:\\Program Files\\Orca',
          grants: moved.grants
        })
      ).result
    ).toEqual({ mode: 'repaired' })
    expect(moved.passes).toHaveLength(2)
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
    const stale = fakePackageGrant()
    await repair({ userDataPath, grants: stale.grants })
    expect(stale.passes).toHaveLength(2)

    resetWindowsInstallDirAclRepairForTest()
    writeFileSync(markerFile, '{ not json')
    const corrupt = fakePackageGrant()
    await repair({ userDataPath, grants: corrupt.grants })
    expect(corrupt.passes).toHaveLength(2)
  })

  it('records the summed failed-entry count when a standard user cannot write the ACL', async () => {
    const { grants, passes } = fakePackageGrant((pass) =>
      pass === 'tree'
        ? { ok: false, failedFileCount: 81, reason: 'failed-files: Access is denied.' }
        : { ok: false, failedFileCount: 1, reason: 'Access is denied.' }
    )
    const { result, data } = await repair({ grants })

    expect(result).toMatchObject({ mode: 'failed', failedFileCount: 82 })
    expect(data.status).toBe('failed')
    expect(data.failedFileCount).toBe(82)
    expect(String(data.reason)).toContain('root: Access is denied.')
    expect(String(data.reason)).toContain('tree: failed-files')
    expect(passes).toHaveLength(2)
  })

  it('still runs the per-file pass when the root grant fails', async () => {
    const { grants, passes } = fakePackageGrant((pass) =>
      pass === 'root' ? { ok: false, failedFileCount: 1, reason: 'Access is denied.' } : {}
    )
    const { result } = await repair({ grants })
    expect(passes.map((entry) => entry.pass)).toEqual(['root', 'tree'])
    expect(result.mode).toBe('failed')
  })

  it('does not throw when a grant rejects, and still records a breadcrumb', async () => {
    const grants = grantsFrom(() => Promise.reject(new Error('Win32 error 5')))
    const { result, data } = await repair({ grants })
    expect(result.mode).toBe('failed')
    expect(data.status).toBe('failed')
    expect(String(data.reason)).toContain('Win32 error 5')
  })

  it('marks the attempt so a hopeless install does not re-walk the tree every launch', async () => {
    const userDataPath = userDataDir()
    await repair({ userDataPath, grants: deniedGrant().grants })

    const marker = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE), 'utf-8')
    ) as { outcome: string }
    expect(marker.outcome).toBe('failed')
  })

  // One failure must not pin this version permanently: Defender locks/timeouts may clear on later bounded retries.
  it('retries a failed repair on later launches, then stops once the budget is spent', async () => {
    const userDataPath = userDataDir()
    const failing = deniedGrant()
    for (let attempt = 0; attempt < 3; attempt++) {
      resetWindowsInstallDirAclRepairForTest()
      expect((await repair({ userDataPath, grants: failing.grants })).result.mode).toBe('failed')
    }
    expect(failing.passes).toHaveLength(6)

    resetWindowsInstallDirAclRepairForTest()
    const spent = fakePackageGrant()
    const { result } = await repair({ userDataPath, grants: spent.grants })
    expect(result).toEqual({ mode: 'marker-hit', alreadyRepaired: false })
    expect(spent.passes).toHaveLength(0)
  })

  it('stops retrying immediately once a repair has succeeded', async () => {
    const userDataPath = userDataDir()
    resetWindowsInstallDirAclRepairForTest()
    await repair({ userDataPath, grants: deniedGrant().grants })
    resetWindowsInstallDirAclRepairForTest()
    expect((await repair({ userDataPath })).result).toEqual({ mode: 'repaired' })

    resetWindowsInstallDirAclRepairForTest()
    const after = fakePackageGrant()
    expect((await repair({ userDataPath, grants: after.grants })).result).toEqual({
      mode: 'marker-hit',
      alreadyRepaired: true
    })
    expect(after.passes).toHaveLength(0)
  })

  it('is a no-op off win32 and in serve mode', async () => {
    const off = fakePackageGrant()
    repairWindowsInstallDirPackageAcl({
      platform: 'darwin',
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      userDataPath: userDataDir(),
      grants: off.grants,
      recordBreadcrumb: vi.fn(),
      onDone: () => expect.unreachable('no-op must not settle')
    })
    resetWindowsInstallDirAclRepairForTest()
    const serve = fakePackageGrant()
    const recordServe = vi.fn()
    repairWindowsInstallDirPackageAcl({
      platform: 'win32',
      isServeMode: true,
      installDir: INSTALL_DIR,
      appVersion: APP_VERSION,
      userDataPath: userDataDir(),
      grants: serve.grants,
      recordBreadcrumb: recordServe,
      onDone: () => expect.unreachable('no-op must not settle')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(off.passes).toHaveLength(0)
    expect(serve.passes).toHaveLength(0)
    expect(recordServe).not.toHaveBeenCalled()
  })

  it('offers text-only commands that mirror the two in-process grants', () => {
    expect(buildInstallDirAclRepairCommands(INSTALL_DIR)).toEqual([
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`,
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`
    ])
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})

describe('isInstallDirAclPoisonVerdict', () => {
  it('only accepts the probe verdict that reproduced the crash', () => {
    expect(
      isInstallDirAclPoisonVerdict({
        status: 'ok',
        matchesPoisonSignature: true
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
})
