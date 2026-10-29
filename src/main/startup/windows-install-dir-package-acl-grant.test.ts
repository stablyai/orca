import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests,
  WINDOWS_FILE_READ_EXECUTE,
  type GrantAccessOptions,
  type WindowsSecurityAddon
} from '../../shared/windows-security-addon'
import {
  grantInstallDirPackageRoot,
  grantInstallDirPackageTree,
  RESTRICTED_APP_PACKAGES_SID
} from './windows-install-dir-package-acl-grant'

type GrantCall = {
  path: string
  sid: string
  accessMask: number
  options: GrantAccessOptions
}

function unexpected(): never {
  throw new Error('the package grant must only read DACLs and call grantAccessAsync')
}

/** Normalize addon namespaced paths for comparison with fixture paths. */
const plain = (path: string) => (path.startsWith('\\\\?\\') ? path.slice(4) : path)

/** Fake grants/DACL reads; only protectedDirs refuse inheritance. */
function installFakeAddon(
  fail: (path: string) => boolean = () => false,
  protectedDirs: string[] = []
): GrantCall[] {
  const calls: GrantCall[] = []
  const addon: WindowsSecurityAddon = {
    currentUserSid: () => 'S-1-5-21-1-2-3-1001',
    getDaclAces: (path) => ({ protected: protectedDirs.includes(plain(path)), aces: [] }),
    setDaclSddl: unexpected,
    setDaclSddlAsync: unexpected,
    createFileWithDacl: unexpected,
    grantAccess: unexpected,
    clearStdHandleInheritance: unexpected,
    spawnDetachedIsolated: unexpected,
    hasNativeExport: unexpected,
    grantAccessAsync: async (path, sid, accessMask, options) => {
      calls.push({ path: plain(path), sid, accessMask, options })
      if (fail(plain(path))) {
        throw new Error('SetNamedSecurityInfoW failed with Win32 error 5')
      }
    }
  }
  setWindowsSecurityForTests(addon)
  return calls
}

describe('install-dir package grant passes', () => {
  let installDir: string

  beforeEach(() => {
    installDir = mkdtempSync(join(tmpdir(), 'orca-acl-grant-'))
    mkdirSync(join(installDir, 'resources', 'app.asar.unpacked'), { recursive: true })
    writeFileSync(join(installDir, 'ffmpeg.dll'), 'binary')
    writeFileSync(join(installDir, 'resources', 'app.asar.unpacked', 'addon.node'), 'binary')
  })

  afterEach(() => {
    resetWindowsSecurityLoadForTests()
    rmSync(installDir, { recursive: true, force: true })
  })

  it('grants the root once, inheritable, so files a later update writes inherit it', async () => {
    const calls = installFakeAddon()
    const outcome = await grantInstallDirPackageRoot(installDir)
    expect(outcome).toEqual({ ok: true, failedFileCount: 0 })
    expect(calls).toEqual([
      {
        path: installDir,
        sid: RESTRICTED_APP_PACKAGES_SID,
        accessMask: WINDOWS_FILE_READ_EXECUTE,
        options: { inheritable: true, replace: false }
      }
    ])
  })

  it('grants every file below the root flagless, and leaves the root to the root pass', async () => {
    const calls = installFakeAddon()
    const outcome = await grantInstallDirPackageTree(installDir)
    expect(outcome).toEqual({ ok: true, failedFileCount: 0 })
    expect(calls.map((call) => call.path).sort()).toEqual(
      [
        join(installDir, 'ffmpeg.dll'),
        join(installDir, 'resources', 'app.asar.unpacked', 'addon.node')
      ].sort()
    )
    for (const call of calls) {
      expect(call.sid).toBe(RESTRICTED_APP_PACKAGES_SID)
      expect(call.accessMask).toBe(WINDOWS_FILE_READ_EXECUTE)
      expect(call.options).toEqual({ inheritable: false, replace: false })
    }
  })

  // Re-granting inherited directories redundantly propagates entire subtrees.
  it('grants a directory only when its own DACL is protected, inheritably', async () => {
    const shielded = join(installDir, 'resources', 'app.asar.unpacked')
    const calls = installFakeAddon(() => false, [shielded])
    await grantInstallDirPackageTree(installDir)
    const directoryGrants = calls.filter((call) => !/\.(dll|node)$/.test(call.path))
    expect(directoryGrants).toEqual([
      {
        path: shielded,
        sid: RESTRICTED_APP_PACKAGES_SID,
        accessMask: WINDOWS_FILE_READ_EXECUTE,
        options: { inheritable: true, replace: false }
      }
    ])
  })

  it('never replaces existing rules on either pass', async () => {
    const calls = installFakeAddon()
    await grantInstallDirPackageRoot(installDir)
    await grantInstallDirPackageTree(installDir)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => call.options.replace === false)).toBe(true)
  })

  it('does not follow a link out of the install tree', async (context) => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-acl-grant-outside-'))
    writeFileSync(join(outside, 'elsewhere.dll'), 'binary')
    try {
      symlinkSync(outside, join(installDir, 'linked'), 'junction')
    } catch {
      rmSync(outside, { recursive: true, force: true })
      context.skip()
      return
    }
    try {
      const calls = installFakeAddon()
      await grantInstallDirPackageTree(installDir)
      const paths = calls.map((call) => call.path)
      expect(paths).not.toContain(join(installDir, 'linked'))
      expect(paths.some((path) => path.includes('elsewhere.dll'))).toBe(false)
    } finally {
      rmSync(join(installDir, 'linked'), { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps going past failed entries and counts them, like icacls /T /C', async () => {
    const calls = installFakeAddon((path) => path.endsWith('.dll') || path.endsWith('.node'))
    const outcome = await grantInstallDirPackageTree(installDir)
    expect(calls).toHaveLength(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.failedFileCount).toBe(2)
    expect(outcome.reason).toMatch(/^failed-files: .*Win32 error 5/)
  })

  it('counts a failed root grant as one failed entry', async () => {
    installFakeAddon(() => true)
    const outcome = await grantInstallDirPackageRoot(installDir)
    expect(outcome).toMatchObject({ ok: false, failedFileCount: 1 })
    expect(outcome.reason).toContain('Win32 error 5')
  })

  it('reports an unavailable addon instead of granting anything', async () => {
    setWindowsSecurityForTests(null)
    expect(await grantInstallDirPackageRoot(installDir)).toEqual({
      ok: false,
      failedFileCount: 0,
      reason: 'addon-unavailable'
    })
    expect(await grantInstallDirPackageTree(installDir)).toEqual({
      ok: false,
      failedFileCount: 0,
      reason: 'addon-unavailable'
    })
  })

  // Windows security APIs need extended-length paths beyond MAX_PATH; the host wrapper namespaces once.
  it.runIf(process.platform === 'win32')(
    'reaches a path past MAX_PATH through the extended-length prefix',
    async () => {
      const calls = installFakeAddon()
      const longDir = `C:\\Program Files\\${'orca'.repeat(70)}`
      const seen: string[] = []
      setWindowsSecurityForTests({
        currentUserSid: () => 'S-1-5-21-1-2-3-1001',
        getDaclAces: unexpected,
        setDaclSddl: unexpected,
        setDaclSddlAsync: unexpected,
        createFileWithDacl: unexpected,
        grantAccess: unexpected,
        clearStdHandleInheritance: unexpected,
        spawnDetachedIsolated: unexpected,
        hasNativeExport: unexpected,
        grantAccessAsync: async (path) => {
          seen.push(path)
        }
      })
      await grantInstallDirPackageRoot(longDir)
      expect(calls).toEqual([])
      expect(seen).toEqual([`\\\\?\\${longDir}`])
    }
  )
})
