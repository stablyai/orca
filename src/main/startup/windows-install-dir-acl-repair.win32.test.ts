import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getIcaclsExePath } from '../win32-utils'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
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

/**
 * The other half of the ACL proof: the unit tests fake icacls, and this one runs
 * the real binary against a real poisoned tree on a real Windows box.
 *
 * Both are needed. `icacls <file> /grant "*S-1-15-2-2:(OI)(CI)(RX)"` exits 0 and
 * prints "Failed processing 0 files" while writing no ACE at all — a model of
 * icacls cannot catch that, and it is the exact mistake that leaves the app dead.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

/** An unresolvable AppContainer SID, the shape the field hosts carry. */
const ORPHAN_SID =
  '*S-1-15-2-1111111111-2222222222-3333333333-4444444444-5555555555-6666666666-7777777777'
const RESTRICTED_PACKAGES_NAME = /ALL RESTRICTED APPLICATION PACKAGES/i

async function icacls(...args: string[]): Promise<{ code: number | null; out: string }> {
  const result = await runProcess({ program: getIcaclsExePath(), args, timeoutMs: 30_000 })
  return { code: result.code, out: `${result.stdout}\n${result.stderr}` }
}

/** Explicit DACL, inheritance off: what a shipped module carries, and why a root grant alone is not enough. */
async function createProtectedFile(path: string): Promise<void> {
  writeFileSync(path, 'binary')
  await icacls(path, '/inheritance:d')
}

describeOnWindows('install-dir package ACL repair against the real icacls', () => {
  let installDir: string
  let userDataPath: string
  let moduleFile: string
  let trapFile: string

  beforeAll(async () => {
    installDir = mkdtempSync(join(tmpdir(), 'orca-acl-live-'))
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-live-ud-'))
    mkdirSync(join(installDir, 'resources'), { recursive: true })
    moduleFile = join(installDir, 'ffmpeg.dll')
    trapFile = join(installDir, 'resources', 'trap.dll')
    await createProtectedFile(moduleFile)
    await createProtectedFile(trapFile)
    // Poison: an orphan package ACE on the tree and on the module, no well-known grant.
    await icacls(installDir, '/grant', `${ORPHAN_SID}:(OI)(CI)(RX)`)
    await icacls(moduleFile, '/grant', `${ORPHAN_SID}:(RX)`)
    await icacls(trapFile, '/grant', `${ORPHAN_SID}:(RX)`)
  })

  afterAll(() => {
    // Why removeTreeSync: two icacls.exe children just rewrote DACLs on this tree, so a
    // raw rmSync races handles Windows has not released and throws EPERM after the
    // assertions already passed.
    removeTreeSync(installDir)
    removeTreeSync(userDataPath)
  })

  function probeVerdict(): Promise<Record<string, unknown>> {
    resetWindowsInstallDirAclProbeForTest()
    return new Promise((resolve) => {
      probeWindowsInstallDirAcl({
        installDir,
        recordBreadcrumb: () => undefined,
        onDone: (data) => resolve(data as Record<string, unknown>)
      })
    })
  }

  // The trap, pinned against the real binary: this is the form that looks like it worked.
  it('confirms an inheritance-flagged grant silently writes nothing to a file', async () => {
    const flagged = await icacls(trapFile, '/grant', '*S-1-15-2-2:(OI)(CI)(RX)')
    expect(flagged.code).toBe(0)
    expect(flagged.out).toMatch(/Failed processing 0 files?/i)
    const after = await icacls(trapFile)
    expect(after.out).not.toMatch(RESTRICTED_PACKAGES_NAME)
  })

  it('repairs the tree before the window, and the grant lands on the module file', async () => {
    expect((await probeVerdict()).matchesPoisonSignature).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    // The state a launch that died mid-repair leaves behind.
    writeInstallDirAclPoisonMarker(userDataPath, installDir, '1.4.196')

    const startedAt = Date.now()
    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      installDir,
      userDataPath,
      appVersion: '1.4.196',
      recordBreadcrumb: () => undefined
    })
    console.log(`[live-acl] blocking repair ${mode} in ${Date.now() - startedAt}ms`)
    expect(mode).toBe('repaired')

    // A directory grant is not enough: the file carries its own DACL.
    expect((await icacls(moduleFile)).out).toMatch(RESTRICTED_PACKAGES_NAME)
    // The /T pass must also reach a NESTED protected file — the shape app.asar.unpacked
    // and node_modules actually have.
    expect((await icacls(trapFile)).out).toMatch(RESTRICTED_PACKAGES_NAME)
    // And the (OI)(CI) root grant exists so files a later update writes inherit it.
    const updateFile = join(installDir, 'resources', 'added-by-update.dll')
    writeFileSync(updateFile, 'binary')
    expect((await icacls(updateFile)).out).toMatch(RESTRICTED_PACKAGES_NAME)
    expect((await probeVerdict()).matchesPoisonSignature).toBe(false)
  })
})
