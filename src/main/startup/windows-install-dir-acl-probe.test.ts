import { join } from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest,
  WINDOWS_INSTALL_DIR_ACL_BREADCRUMB,
  type WindowsInstallDirAclProbeOptions
} from './windows-install-dir-acl-probe'
import {
  ALL_PACKAGES_ACE,
  ENGLISH_BASELINE_ACES,
  fakeIcaclsSpawn,
  FRENCH_BASELINE_ACES,
  FRENCH_RESTRICTED_PACKAGES_ACE,
  icaclsDacl,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const ORPHAN = ORPHAN_PACKAGE_ACE
const RESTRICTED_GRANT = RESTRICTED_PACKAGES_ACE

function dacl(target: string, firstAce: string, ...rest: string[]): string {
  return icaclsDacl(target, [firstAce, ...rest])
}

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
  return probe({ spawnFn: fakeSpawn((target) => dacl(target, aces[0], ...aces.slice(1))).spawnFn })
}

describe('probeWindowsInstallDirAcl', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
  })

  it('reports a clean DACL as unpoisoned', async () => {
    const data = await probe({
      spawnFn: fakeSpawn((target) => icaclsDacl(target, [], ENGLISH_BASELINE_ACES)).spawnFn
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
    ['the localized-safe name form', ALL_PACKAGES_ACE],
    ['the raw SID form', 'S-1-15-2-1:(OI)(CI)(RX)']
  ])('clears the signature when only ALL APPLICATION PACKAGES grants (%s)', async (_l, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  // The reproduced remedy was an additive *grant*; an ACE that grants nothing on
  // the object cannot satisfy the orphan, so it must not clear the signature.
  it.each([
    ['deny', 'APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(DENY)(OI)(CI)(F)'],
    ['inherit-only', 'APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(OI)(CI)(IO)(GR,GE)'],
    ['raw-sid deny', 'S-1-15-2-2:(DENY)(F)'],
    ['raw-sid inherit-only', 'S-1-15-2-1:(OI)(CI)(IO)(GR,GE)']
  ])('does not let a %s well-known ACE satisfy an orphan', async (_label, ace) => {
    const data = await probeWith(ace, ORPHAN)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.hasRestrictedPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('does not let a grant on one target mask its absence on another', async () => {
    const data = await probe({
      spawnFn: fakeSpawn((target) =>
        target.endsWith('ffmpeg.dll')
          ? dacl(target, ORPHAN)
          : dacl(target, RESTRICTED_GRANT, ORPHAN)
      ).spawnFn
    })
    expect(data.hasWellKnownPackageGrant).toBe(true)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('reports whether the well-known name check could be trusted', async () => {
    const english = await probeWith(ORPHAN)
    expect(english.wellKnownNameCheckReliable).toBe(true)
    const localized = await new Promise<Record<string, unknown>>((resolve) => {
      resetWindowsInstallDirAclProbeForTest()
      probeWindowsInstallDirAcl({
        platform: 'win32',
        installDir: INSTALL_DIR,
        fileExists: () => false,
        // fr-FR install that already carries the restricted grant: the name check
        // cannot see it, so the signature is a false positive the flag must expose.
        spawnFn: fakeSpawn((target) =>
          icaclsDacl(target, [ORPHAN, FRENCH_RESTRICTED_PACKAGES_ACE], FRENCH_BASELINE_ACES)
        ).spawnFn,
        recordBreadcrumb: (_name, d) => {
          resolve(d as Record<string, unknown>)
          return undefined
        }
      })
    })
    expect(localized.matchesPoisonSignature).toBe(true)
    expect(localized.wellKnownNameCheckReliable).toBe(false)
  })

  it('matches the well-known SIDs exactly, not by prefix', async () => {
    const data = await probeWith('S-1-15-2-1234567890:(OI)(CI)(RX)')
    expect(data.orphanPackageSidCount).toBe(1)
    expect(data.hasWellKnownPackageGrant).toBe(false)
    expect(data.matchesPoisonSignature).toBe(true)
  })

  it('ignores capability SIDs, which are a different family and harmless', async () => {
    const data = await probeWith('S-1-15-3-65536-599108337-2355189375-1353122160:(S,X)')
    expect(data.orphanPackageSidCount).toBe(0)
    expect(data.matchesPoisonSignature).toBe(false)
  })

  it('probes a content file, not just the directory object', async () => {
    const fake = fakeSpawn((target) => dacl(target, ORPHAN))
    await probe({ spawnFn: fake.spawnFn })
    expect(fake.calls.map((c) => c.args[0])).toEqual([INSTALL_DIR, join(INSTALL_DIR, 'ffmpeg.dll')])
  })

  it('never passes a recursive or write flag', async () => {
    const fake = fakeSpawn((target) => dacl(target, ORPHAN))
    await probe({ spawnFn: fake.spawnFn })
    for (const call of fake.calls) {
      expect(call.args).toHaveLength(1)
      expect(call.args[0]).not.toMatch(/^\//)
    }
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
    const fake = fakeSpawn((target) => dacl(target, ORPHAN))
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
    const fake = fakeSpawn((target) => dacl(target, ORPHAN))
    await probe({ spawnFn: fake.spawnFn })
    const before = fake.calls.length
    probeWindowsInstallDirAcl({ platform: 'win32', installDir: INSTALL_DIR, spawnFn: fake.spawnFn })
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.calls).toHaveLength(before)
  })
})
