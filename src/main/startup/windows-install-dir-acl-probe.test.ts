import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest,
  WINDOWS_INSTALL_DIR_ACL_BREADCRUMB,
  type WindowsInstallDirAclProbeOptions
} from './windows-install-dir-acl-probe'
import { isInstallDirAclPoisonVerdict } from './windows-install-dir-package-acl-repair'
import {
  ALL_PACKAGES_ACE,
  fakeIcaclsSpawn,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const ORPHAN = ORPHAN_PACKAGE_ACE
const RESTRICTED_GRANT = RESTRICTED_PACKAGES_ACE

const fakeSpawn = fakeIcaclsSpawn

function probe(options: WindowsInstallDirAclProbeOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      fileExists: (path) => path.endsWith('ffmpeg.dll'),
      ...options,
      recordBreadcrumb: (name, data) => {
        resolve({ ...(data as Record<string, unknown>), name })
        return undefined
      }
    })
  })
}

/** Every target returns the same ACE set on top of the system baseline. */
function probeWith(...aces: string[]): Promise<Record<string, unknown>> {
  return probe({ spawnFn: fakeSpawn(() => aces).spawnFn })
}

describe('probeWindowsInstallDirAcl', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
  })

  it('reports a clean DACL as unpoisoned', async () => {
    const data = await probe({
      spawnFn: fakeSpawn(() => []).spawnFn
    })
    expect(data.name).toBe(WINDOWS_INSTALL_DIR_ACL_BREADCRUMB)
    expect(data.status).toBe('ok')
    expect(data.orphanPackageSidCount).toBe(0)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  it('flags an orphan package SID with no well-known grant', async () => {
    const data = await probeWith(ORPHAN)
    expect(data.matchesPoisonSignature).toBe(true)
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.orphanPackageSids).toBe('S-1-15-2-999-999-999')
    expect(data.hasWellKnownPackageGrant).toBe(false)
  })

  it('clears the signature once the restricted package ACE grants access', async () => {
    const data = await probeWith(RESTRICTED_GRANT, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.hasRestrictedPackageGrant).toBe(true)
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  // A Program Files install inherits ALL APPLICATION PACKAGES by default, and an
  // orphan alongside it launched clean on win32 10.0.26200 / Electron 43.4.1 — so
  // it is not the reproduced state, however useless -1 is to an LPAC token.
  it.each([
    ['the AC alias', ALL_PACKAGES_ACE],
    ['the raw SID form', '(A;OICI;0x1200a9;;;S-1-15-2-1)']
  ])('clears the signature when only ALL APPLICATION PACKAGES grants (%s)', async (_l, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  // The reproduced remedy was an additive *grant*; an ACE that grants nothing on
  // the object cannot satisfy the orphan, so it must not clear the signature.
  it.each([
    ['deny', '(D;OICI;FA;;;AC)'],
    ['inherit-only', '(A;OICIIO;GRGX;;;AC)'],
    ['restricted deny', '(D;;FA;;;S-1-15-2-2)'],
    ['restricted inherit-only', '(A;CIOIIO;GRGX;;;S-1-15-2-2)']
  ])('does not let a %s well-known ACE satisfy an orphan', async (_label, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('does not let a grant on one target mask its absence on another', async () => {
    const data = await probe({
      spawnFn: fakeSpawn((target) =>
        target.endsWith('ffmpeg.dll') ? [ORPHAN] : [RESTRICTED_GRANT, ORPHAN]
      ).spawnFn
    })
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  // zh-CN/ja-JP/ko-KR icacls keeps "NT AUTHORITY" English but translates the package
  // names and summary. A tree the repair just fixed read as poisoned AND reliable there,
  // re-arming the pre-window repair and blaming the install on every launch.
  it('reads a repaired tree as clean when icacls translates package names', async () => {
    const zhDisplay = (target: string): string =>
      [
        `${target} S-1-15-2-999-999-999:(OI)(CI)(RX)`,
        '    APPLICATION PACKAGE AUTHORITY\\所有受限制的应用程序包:(OI)(CI)(RX)',
        '    NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
        '    BUILTIN\\Administrators:(I)(OI)(CI)(F)',
        '',
        '已成功处理 1 个文件; 处理 0 个文件时失败'
      ].join('\r\n')
    let verdict: CrashReportBreadcrumbData = {}
    const data = await probe({
      spawnFn: fakeSpawn(() => [ORPHAN, RESTRICTED_GRANT], zhDisplay).spawnFn,
      onDone: (done) => (verdict = done)
    })
    expect(isInstallDirAclPoisonVerdict(verdict)).toBe(false)
    expect(data.status).toBe('ok')
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.hasRestrictedPackageGrant).toBe(true)
  })

  it('matches the well-known SIDs exactly, not by prefix', async () => {
    const data = await probeWith('(A;OICI;0x1200a9;;;S-1-15-2-1234567890)')
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('ignores capability SIDs, which are a different family and harmless', async () => {
    const data = await probeWith('(A;;0x100020;;;S-1-15-3-65536-599108337-2355189375-1353122160)')
    expect(data.orphanPackageSidCount).toBe(0)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  it('probes a content file, not just the directory object', async () => {
    const fake = fakeSpawn(() => [ORPHAN])
    await probe({ spawnFn: fake.spawnFn })
    expect(fake.calls.map((c) => c.args[0])).toEqual([INSTALL_DIR, join(INSTALL_DIR, 'ffmpeg.dll')])
  })

  it('only saves the DACL to a temp file: no recursive or ACL-writing flag', async () => {
    const fake = fakeSpawn(() => [ORPHAN])
    await probe({ spawnFn: fake.spawnFn })
    for (const call of fake.calls) {
      expect(call.args).toHaveLength(3)
      expect(call.args[0]).not.toMatch(/^\//)
      expect(call.args[1]).toBe('/save')
      expect(call.args[2].startsWith(tmpdir())).toBe(true)
      expect(existsSync(call.args[2])).toBe(false)
    }
  })

  // Verbatim `icacls <dir> /save` / `icacls <file> /save` output from win32 10.0.26200.
  it.each([
    [
      'a repaired module file',
      'ffmpeg.dll\r\nD:AI(A;;0x1200a9;;;S-1-15-2-2)(A;;0x1200a9;;;S-1-15-2-999-999-999)' +
        '(A;ID;0x1200a9;;;S-1-15-2-999-999-999)(A;ID;FA;;;SY)(A;ID;FA;;;BA)' +
        '(A;ID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)\r\n',
      false
    ],
    [
      'a poisoned dir whose AC ACE denies',
      'scan21acl\r\nD:AI(D;;0x100116;;;AC)(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)' +
        '(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)' +
        '(A;OICIID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)\r\n',
      true
    ]
  ])('reads a real icacls /save capture: %s', async (_label, saved, poisoned) => {
    const data = await probe({
      fileExists: () => false,
      spawnFn: fakeSpawn(() => Buffer.from(saved, 'utf16le')).spawnFn
    })
    expect(data.orphanPackageSids).toBe('S-1-15-2-999-999-999')
    expect(data.matchesPoisonSignature).toBe(poisoned)
  })

  it('keeps a conditional DACL unreadable instead of hiding a later package grant', async () => {
    const saved =
      'orca\r\nD:AI(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)' +
      '(XA;OICI;FA;;;WD;(@User.Department == "Finance"))' +
      '(A;OICIID;0x1200a9;;;S-1-15-2-2)\r\n'
    let verdict: CrashReportBreadcrumbData = {}
    const data = await probe({
      fileExists: () => false,
      spawnFn: fakeSpawn(() => Buffer.from(saved, 'utf16le')).spawnFn,
      onDone: (done) => (verdict = done)
    })
    expect(data).toMatchObject({ status: 'failed', reason: 'all-targets-unreadable' })
    expect(data.matchesPoisonSignature).toBeUndefined()
    expect(isInstallDirAclPoisonVerdict(verdict)).toBe(false)
  })

  it('does not report malformed saved output as a clean DACL', async () => {
    const data = await probe({
      fileExists: () => false,
      spawnFn: fakeSpawn(() => Buffer.from('orca\r\n', 'utf16le')).spawnFn
    })
    expect(data).toMatchObject({ status: 'failed', reason: 'all-targets-unreadable' })
    expect(data.matchesPoisonSignature).toBeUndefined()
  })

  it('records a failure instead of throwing when icacls cannot be read', async () => {
    const data = await probe({ spawnFn: fakeSpawn(() => null).spawnFn })
    expect(data.status).toBe('failed')
    expect(data.reason).toBe('all-targets-unreadable')
    expect(data.matchesPoisonSignature).toBeUndefined()
  })

  it.each([
    ['darwin', { platform: 'darwin' as NodeJS.Platform }],
    ['serve mode', { platform: 'win32' as NodeJS.Platform, isServeMode: true }]
  ])('does no work on %s', async (_label, options) => {
    const fake = fakeSpawn(() => [ORPHAN])
    const record = vi.fn()
    const fileExists = vi.fn(() => true)
    probeWindowsInstallDirAcl({
      installDir: INSTALL_DIR,
      spawnFn: fake.spawnFn,
      fileExists,
      recordBreadcrumb: record,
      ...options
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.calls).toHaveLength(0)
    expect(fileExists).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('runs once per process', async () => {
    const fake = fakeSpawn(() => [ORPHAN])
    await probe({ spawnFn: fake.spawnFn })
    const before = fake.calls.length
    probeWindowsInstallDirAcl({ platform: 'win32', installDir: INSTALL_DIR, spawnFn: fake.spawnFn })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.calls).toHaveLength(before)
  })
})
