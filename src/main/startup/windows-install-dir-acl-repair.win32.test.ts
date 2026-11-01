import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  loadWindowsSecurity,
  WINDOWS_FILE_READ_EXECUTE,
  type WindowsSecurity
} from '../../shared/windows-security-addon'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest
} from './windows-install-dir-acl-probe'
import { writeInstallDirAclPoisonMarker } from './windows-install-dir-acl-poison-marker'
import {
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'

/** Read back real in-process grants on a poisoned Windows tree; unit doubles cannot prove native ACL effects. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

/** An unresolvable AppContainer SID, the shape the field hosts carry. */
const ORPHAN_SID =
  'S-1-15-2-1111111111-2222222222-3333333333-1234567890-2345678901-3456789012-4012345678'
const RESTRICTED_SID = 'S-1-15-2-2'
const READ_EXECUTE = WINDOWS_FILE_READ_EXECUTE
const FULL_CONTROL = 0x1f01ff
const INHERITED_ACE = 0x10

function requireSecurity(): WindowsSecurity {
  const loaded = loadWindowsSecurity()
  if ('error' in loaded) {
    throw new Error(`the windows-security addon must load on a Windows test host: ${loaded.error}`)
  }
  return loaded
}

describeOnWindows('install-dir package ACL repair against real DACLs', () => {
  let addon: WindowsSecurity['addon']
  let userSid: string
  let installDir: string
  let userDataPath: string
  let moduleFile: string
  let nestedFile: string

  /** Explicit DACL, inheritance off: what a shipped module carries, and why a root grant alone is not enough. */
  function createProtectedFile(path: string): void {
    writeFileSync(path, 'binary')
    addon.setDaclSddl(
      path,
      `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${userSid})(A;;0x1200a9;;;${ORPHAN_SID})`
    )
  }

  beforeAll(() => {
    ;({ addon, userSid } = requireSecurity())
    installDir = mkdtempSync(join(tmpdir(), 'orca-acl-live-'))
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-live-ud-'))
    mkdirSync(join(installDir, 'resources'), { recursive: true })
    moduleFile = join(installDir, 'ffmpeg.dll')
    nestedFile = join(installDir, 'resources', 'nested.dll')
    createProtectedFile(moduleFile)
    createProtectedFile(nestedFile)
    // Poison: an orphan package ACE on the tree, no well-known package grant anywhere.
    addon.grantAccess(installDir, ORPHAN_SID, WINDOWS_FILE_READ_EXECUTE, {
      inheritable: true,
      replace: false
    })
  })

  afterAll(() => {
    // Use Windows handle-race retries after DACL rewrites; raw rm can fail EPERM after passing assertions.
    removeTreeSync(installDir)
    removeTreeSync(userDataPath)
  })

  function probeVerdict(): Promise<CrashReportBreadcrumbData> {
    resetWindowsInstallDirAclProbeForTest()
    return new Promise((resolve) => {
      probeWindowsInstallDirAcl({
        installDir,
        recordBreadcrumb: () => undefined,
        onDone: resolve
      })
    })
  }

  it('repairs the tree before the window, and the grant lands on each module file', async () => {
    expect((await probeVerdict()).matchesPoisonSignature).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    // Model a launch that died after recording poison.
    writeInstallDirAclPoisonMarker(userDataPath, installDir, '1.4.196')

    const startedAt = performance.now()
    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      installDir,
      userDataPath,
      appVersion: '1.4.196',
      recordBreadcrumb: () => undefined
    })
    console.log(
      `[live-acl] blocking repair ${mode} in ${(performance.now() - startedAt).toFixed(1)}ms`
    )
    expect(mode).toBe('repaired')

    // Protected root/nested modules each need a flagless grant; inheritable directory access cannot reach them.
    const allow = (sid: string, mask: number, flags = 0) =>
      expect.objectContaining({ type: 0, flags, mask, sid })
    for (const file of [moduleFile, nestedFile]) {
      const aces = addon.getDaclAces(file)?.aces
      expect(aces).toContainEqual(allow(RESTRICTED_SID, READ_EXECUTE))
      // Preserve SYSTEM/admin/user/orphan ACEs: repair is additive.
      for (const sid of ['S-1-5-18', 'S-1-5-32-544', userSid]) {
        expect(aces).toContainEqual(allow(sid, FULL_CONTROL))
      }
      expect(aces).toContainEqual(allow(ORPHAN_SID, READ_EXECUTE))
    }
    // Verify future update files inherit the root grant.
    const updateFile = join(installDir, 'resources', 'added-by-update.dll')
    writeFileSync(updateFile, 'binary')
    expect(addon.getDaclAces(updateFile)?.aces).toContainEqual(
      allow(RESTRICTED_SID, READ_EXECUTE, INHERITED_ACE)
    )
    expect((await probeVerdict()).matchesPoisonSignature).toBe(false)
  })
})
