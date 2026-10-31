import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests,
  type GrantAccessOptions,
  type WindowsSecurityAddon
} from '../../shared/windows-security-addon'

import { grantInstallDirPackageTree } from './windows-install-dir-package-acl-grant'

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
    readFileWithDacl: unexpected,
    readGenericCredential: unexpected,
    writeGenericCredential: unexpected,
    grantAccess: unexpected,
    clearStdHandleInheritance: unexpected,
    spawnDetachedIsolated: unexpected,
    isolatedSpawnBreaksAwayFromJob: unexpected,
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
})
