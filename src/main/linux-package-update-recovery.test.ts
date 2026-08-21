import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { LinuxPackageInstallRecovery } from '../shared/update-status-types'
import type * as RecoveryModule from './linux-package-update-recovery'

const { showItemInFolderMock, getPackageTypeMock, buildCommandMock, hashPasses } = vi.hoisted(
  () => ({
    showItemInFolderMock: vi.fn(),
    getPackageTypeMock: vi.fn(),
    buildCommandMock: vi.fn(),
    hashPasses: { count: 0 }
  })
)

vi.mock('electron', () => ({ shell: { showItemInFolder: showItemInFolderMock } }))

vi.mock('./linux-update-package-type', () => ({ getLinuxRootPackageType: getPackageTypeMock }))

vi.mock('./linux-package-install-command', () => ({
  buildLinuxPackageInstallCommand: buildCommandMock
}))

// Counts hash passes without changing read behavior.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      hashPasses.count += 1
      return actual.createReadStream(...args)
    }
  }
})

// Real symlinks, POSIX modes, and the XDG cache layout make these cases meaningless on Windows.
const describePosix = describe.skipIf(process.platform === 'win32')

const VERSION = '1.2.3'
const PAYLOAD = 'orca package payload'
const SHA512 = createHash('sha512').update(PAYLOAD).digest('base64')

let recovery: typeof RecoveryModule
let tempRoot: string
let cacheRoot: string
let updaterDir: string
let downloadDir: string
let outsideDir: string

function recoveryFor(overrides: Partial<LinuxPackageInstallRecovery> = {}) {
  return {
    kind: 'linux-package-install',
    packageType: 'deb',
    reason: 'package-install-failed',
    version: VERSION,
    ...overrides
  } satisfies LinuxPackageInstallRecovery
}

async function writePackage(name: string, contents = PAYLOAD): Promise<string> {
  const filePath = path.join(downloadDir, name)
  await fsp.writeFile(filePath, contents)
  return filePath
}

/** Captures a well-formed downloaded event unless a field is overridden. */
function capture(overrides: Record<string, unknown> = {}): void {
  const downloadedFile = (overrides.downloadedFile ?? path.join(downloadDir, 'orca.deb')) as string
  recovery.captureLinuxPackageArtifact({
    version: VERSION,
    files: [{ url: path.basename(downloadedFile), sha512: SHA512 }],
    ...overrides,
    downloadedFile
  })
}

beforeEach(async () => {
  vi.resetModules()
  hashPasses.count = 0
  showItemInFolderMock.mockReset()
  getPackageTypeMock.mockReset().mockReturnValue('deb')
  buildCommandMock.mockReset().mockReturnValue({ ok: true, command: 'installed command' })
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-recovery-'))
  cacheRoot = path.join(tempRoot, 'cache')
  updaterDir = path.join(cacheRoot, 'orca-updater')
  // The only shape electron-updater downloads into: <cacheRoot>/<updaterCacheDirName>/pending.
  downloadDir = path.join(updaterDir, 'pending')
  outsideDir = path.join(tempRoot, 'outside')
  await fsp.mkdir(downloadDir, { recursive: true })
  await fsp.mkdir(outsideDir, { recursive: true })
  vi.stubEnv('XDG_CACHE_HOME', cacheRoot)
  recovery = await import('./linux-package-update-recovery')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fsp.rm(tempRoot, { recursive: true, force: true })
})

describe('captureLinuxPackageArtifact', () => {
  it('retains the downloaded package with the digest from the event metadata', () => {
    capture()
    expect(recovery.getTrackedLinuxPackageArtifact()).toEqual({
      packageType: 'deb',
      version: VERSION,
      path: path.join(downloadDir, 'orca.deb'),
      sha512: SHA512
    })
  })

  it('ignores the event on a build that is not a root package', () => {
    getPackageTypeMock.mockReturnValue(null)
    capture()
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('requires an absolute downloaded path', () => {
    capture({ downloadedFile: 'orca.deb' })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('requires a string downloaded path', () => {
    recovery.captureLinuxPackageArtifact({
      downloadedFile: 123,
      version: VERSION,
      files: [{ url: 'orca.deb', sha512: SHA512 }]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('requires the package extension to match the installed format', () => {
    capture({ downloadedFile: path.join(downloadDir, 'orca.rpm') })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('accepts an uppercase extension', () => {
    capture({ downloadedFile: path.join(downloadDir, 'Orca.DEB') })
    expect(recovery.getTrackedLinuxPackageArtifact()?.path).toBe(path.join(downloadDir, 'Orca.DEB'))
  })

  it('requires a non-empty string version', () => {
    capture({ version: 7 })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
    capture({ version: '' })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('matches an absolute file URL by basename', () => {
    capture({
      files: [{ url: 'https://downloads.example.com/releases/1.2.3/orca.deb', sha512: SHA512 }]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()?.sha512).toBe(SHA512)
  })

  it('matches a percent-encoded relative URL against the decoded basename', () => {
    const downloadedFile = path.join(downloadDir, 'Orca Setup 1.2.3.deb')
    capture({ downloadedFile, files: [{ url: 'Orca%20Setup%201.2.3.deb', sha512: SHA512 }] })
    expect(recovery.getTrackedLinuxPackageArtifact()?.path).toBe(downloadedFile)
  })

  it('ignores entries for other files and formats', () => {
    capture({
      files: [
        { url: 'orca.AppImage', sha512: 'other-appimage-digest' },
        { url: 'orca-arm64.deb', sha512: 'other-arch-digest' },
        { url: 'orca.deb', sha512: SHA512 }
      ]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()?.sha512).toBe(SHA512)
  })

  it('accepts duplicate entries that agree on the digest', () => {
    capture({
      files: [
        { url: 'orca.deb', sha512: SHA512 },
        { url: 'https://downloads.example.com/orca.deb', sha512: SHA512 }
      ]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()?.sha512).toBe(SHA512)
  })

  it('refuses an ambiguous basename with two different digests', () => {
    capture({
      files: [
        { url: 'orca.deb', sha512: SHA512 },
        { url: 'https://mirror.example.com/orca.deb', sha512: 'conflicting-digest' }
      ]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses an entry with a missing or non-string digest', () => {
    capture({ files: [{ url: 'orca.deb' }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
    capture({ files: [{ url: 'orca.deb', sha512: 42 }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a digest that cannot decode to 64 bytes', () => {
    // Why: an undecodable digest is a metadata problem — arming here would blame the user's file.
    capture({
      files: [{ url: 'orca.deb', sha512: createHash('sha256').update(PAYLOAD).digest('base64') }]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a digest with characters outside the base64 alphabet', () => {
    // Buffer.from would silently drop the '!', so the round-trip check must reject this.
    capture({ files: [{ url: 'orca.deb', sha512: `${SHA512.slice(0, 4)}!${SHA512.slice(4)}` }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a digest that is not base64 at all', () => {
    capture({ files: [{ url: 'orca.deb', sha512: 'not-a-digest' }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('keeps a retained artifact when a later event carries a malformed digest', () => {
    capture()
    capture({ files: [{ url: 'orca.deb', sha512: 'not-a-digest' }] })
    expect(recovery.getTrackedLinuxPackageArtifact()?.sha512).toBe(SHA512)
  })

  it('refuses a malformed percent-encoded URL', () => {
    capture({ files: [{ url: 'orca%ZZ.deb', sha512: SHA512 }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a missing or non-array file list', () => {
    capture({ files: undefined })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
    capture({ files: { url: 'orca.deb', sha512: SHA512 } })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('tolerates a non-object event', () => {
    expect(() => recovery.captureLinuxPackageArtifact(undefined)).not.toThrow()
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('replaces the retained artifact with a newer download', () => {
    capture()
    capture({
      version: '1.2.4',
      downloadedFile: path.join(downloadDir, 'orca-next.deb'),
      files: [{ url: 'orca-next.deb', sha512: SHA512 }]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toMatchObject({
      version: '1.2.4',
      path: path.join(downloadDir, 'orca-next.deb')
    })
  })

  it('keeps the retained artifact when a new download has no usable digest', () => {
    capture()
    capture({ files: [{ url: 'orca.deb' }] })
    expect(recovery.getTrackedLinuxPackageArtifact()?.path).toBe(path.join(downloadDir, 'orca.deb'))
  })

  it('does not arm recovery from a download with no usable digest', () => {
    capture({ files: [{ url: 'orca.deb' }] })
    capture({ files: [{ url: 'orca%ZZ.deb', sha512: SHA512 }] })
    capture({
      files: [
        { url: 'orca.deb', sha512: SHA512 },
        { url: 'https://mirror.example.com/orca.deb', sha512: 'conflicting-digest' }
      ]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('keeps the retained artifact when an unrelated download event arrives', () => {
    capture()
    capture({ downloadedFile: path.join(downloadDir, 'orca.AppImage') })
    expect(recovery.getTrackedLinuxPackageArtifact()?.path).toBe(path.join(downloadDir, 'orca.deb'))
  })
})

describe('clearTrackedLinuxPackageArtifact', () => {
  it('clears the retained artifact', () => {
    capture()
    recovery.clearTrackedLinuxPackageArtifact()
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('preserves the artifact across a recheck of the same version', () => {
    capture()
    recovery.clearTrackedLinuxPackageArtifactForOtherVersion(VERSION)
    expect(recovery.getTrackedLinuxPackageArtifact()?.version).toBe(VERSION)
  })

  it('clears the artifact when another version takes over', () => {
    capture()
    recovery.clearTrackedLinuxPackageArtifactForOtherVersion('1.3.0')
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('preserves the artifact for an unknown or empty version', () => {
    capture()
    recovery.clearTrackedLinuxPackageArtifactForOtherVersion(undefined)
    recovery.clearTrackedLinuxPackageArtifactForOtherVersion('')
    recovery.clearTrackedLinuxPackageArtifactForOtherVersion(42)
    expect(recovery.getTrackedLinuxPackageArtifact()?.version).toBe(VERSION)
  })

  it('is a no-op without a retained artifact', () => {
    expect(() => recovery.clearTrackedLinuxPackageArtifactForOtherVersion('1.3.0')).not.toThrow()
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })
})

describePosix('resolveLinuxPackageInstallInstructions', () => {
  it('returns the built command and package file name for a verified package', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: true,
      command: 'installed command',
      packageFileName: 'orca.deb'
    })
    expect(buildCommandMock).toHaveBeenCalledWith('deb', filePath)
  })

  it('reports missing without a retained artifact', async () => {
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'missing'
    })
  })

  it('reports missing when the recovery version does not match', async () => {
    await writePackage('orca.deb')
    capture()
    await expect(
      recovery.resolveLinuxPackageInstallInstructions(recoveryFor({ version: '9.9.9' }))
    ).resolves.toEqual({ ok: false, reason: 'missing' })
  })

  it('reports missing when the recovery package type does not match', async () => {
    await writePackage('orca.deb')
    capture()
    await expect(
      recovery.resolveLinuxPackageInstallInstructions(recoveryFor({ packageType: 'rpm' }))
    ).resolves.toEqual({ ok: false, reason: 'missing' })
  })

  it('reports missing when the package was deleted', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await fsp.rm(filePath)
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'missing'
    })
  })

  it('propagates a package-manager discovery failure', async () => {
    await writePackage('orca.deb')
    capture()
    buildCommandMock.mockReturnValue({ ok: false, reason: 'no-sudo' })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'no-sudo'
    })
    buildCommandMock.mockReturnValue({ ok: false, reason: 'no-package-manager' })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'no-package-manager'
    })
  })
})

describePosix('digest validation', () => {
  it('rejects a package whose contents changed', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await fsp.writeFile(filePath, 'tampered payload')
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'hash-mismatch'
    })
  })

  it('rejects a well-formed digest that belongs to another file', async () => {
    await writePackage('orca.deb')
    capture({
      files: [
        { url: 'orca.deb', sha512: createHash('sha512').update('other payload').digest('base64') }
      ]
    })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'hash-mismatch'
    })
  })

  it('never hashes a package that a malformed digest failed to arm', async () => {
    await writePackage('orca.deb')
    capture({ files: [{ url: 'orca.deb', sha512: 'not-a-digest' }] })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'missing'
    })
    expect(hashPasses.count).toBe(0)
  })

  it.runIf(process.getuid?.() !== 0)('reports read-failed for an unreadable package', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await fsp.chmod(filePath, 0o000)
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'read-failed'
    })
    await fsp.chmod(filePath, 0o644)
  })
})

describePosix('cache containment', () => {
  it('rejects a path that traverses out of the cache', async () => {
    const filePath = path.join(outsideDir, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: path.join(downloadDir, '..', '..', '..', 'outside', 'orca.deb') })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a path outside the cache root', async () => {
    const filePath = path.join(outsideDir, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects the cache root itself', async () => {
    const rootAsPackage = path.join(tempRoot, 'cache.deb')
    await fsp.mkdir(rootAsPackage)
    vi.stubEnv('XDG_CACHE_HOME', rootAsPackage)
    capture({ downloadedFile: rootAsPackage })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a directory in place of the package', async () => {
    await fsp.mkdir(path.join(downloadDir, 'orca.deb'))
    capture()
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a symlink to a real package inside the cache', async () => {
    await writePackage('real.deb')
    const linkPath = path.join(downloadDir, 'orca.deb')
    await fsp.symlink(path.join(downloadDir, 'real.deb'), linkPath)
    capture()
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a package whose parent symlink escapes the cache', async () => {
    await fsp.writeFile(path.join(outsideDir, 'orca.deb'), PAYLOAD)
    await fsp.symlink(outsideDir, path.join(cacheRoot, 'escape'))
    capture({ downloadedFile: path.join(cacheRoot, 'escape', 'orca.deb') })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a subdirectory of the pending directory', async () => {
    const nested = path.join(downloadDir, 'nested')
    await fsp.mkdir(nested)
    const filePath = path.join(nested, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('uses the home cache when XDG_CACHE_HOME is unset', async () => {
    // Why: the fallback is the only reason an unset XDG_CACHE_HOME still finds the real download.
    const homeCache = path.join(tempRoot, 'home')
    const homeDownloadDir = path.join(homeCache, '.cache', 'orca-updater', 'pending')
    await fsp.mkdir(homeDownloadDir, { recursive: true })
    const filePath = path.join(homeDownloadDir, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    vi.stubEnv('XDG_CACHE_HOME', '')
    vi.spyOn(os, 'homedir').mockReturnValue(homeCache)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: true,
      command: 'installed command',
      packageFileName: 'orca.deb'
    })
  })
})

// electron-updater builds `downloadedFile` from the cache's own writable update-info.json without
// calling basename, so these pin the accepted shape to the one directory it actually downloads into.
// Defence in depth only — a same-uid process can create its own `pending` directory, and per the
// design's trust model it can already overwrite the real cached package. The load-bearing check is the
// cache-root anchor covered by the `cache containment` describe above.
describePosix('pending-directory anchoring', () => {
  it('rejects a package in an attacker-owned directory under the cache root', async () => {
    const evilDir = path.join(cacheRoot, 'evil')
    await fsp.mkdir(evilDir)
    const filePath = path.join(evilDir, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a package in the updater directory itself', async () => {
    const filePath = path.join(updaterDir, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a pending directory buried deeper than one level under the cache root', async () => {
    const deepPending = path.join(cacheRoot, 'evil', 'nested', 'pending')
    await fsp.mkdir(deepPending, { recursive: true })
    const filePath = path.join(deepPending, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('rejects a pending directory that is a symlink out of the cache', async () => {
    await fsp.writeFile(path.join(outsideDir, 'orca.deb'), PAYLOAD)
    const fakeUpdaterDir = path.join(cacheRoot, 'orca-updater-2')
    await fsp.mkdir(fakeUpdaterDir)
    await fsp.symlink(outsideDir, path.join(fakeUpdaterDir, 'pending'))
    capture({ downloadedFile: path.join(fakeUpdaterDir, 'pending', 'orca.deb') })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'not-regular'
    })
  })

  it('accepts any updater directory name that holds the pending directory', async () => {
    // The cache directory name comes from the app, so only its position is fixed.
    const otherPending = path.join(cacheRoot, 'orca-updater-next', 'pending')
    await fsp.mkdir(otherPending, { recursive: true })
    const filePath = path.join(otherPending, 'orca.deb')
    await fsp.writeFile(filePath, PAYLOAD)
    capture({ downloadedFile: filePath })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: true,
      command: 'installed command',
      packageFileName: 'orca.deb'
    })
  })

  it('accepts a pending directory reached through a symlink that stays in the cache', async () => {
    await writePackage('orca.deb')
    await fsp.symlink(updaterDir, path.join(cacheRoot, 'link-to-updater'))
    capture({ downloadedFile: path.join(cacheRoot, 'link-to-updater', 'pending', 'orca.deb') })
    await expect(recovery.resolveLinuxPackageInstallInstructions(recoveryFor())).resolves.toEqual({
      ok: true,
      command: 'installed command',
      packageFileName: 'orca.deb'
    })
  })
})

describePosix('validation coalescing', () => {
  it('performs one hash pass for concurrent requests', async () => {
    await writePackage('orca.deb')
    capture()
    const [first, second] = await Promise.all([
      recovery.resolveLinuxPackageInstallInstructions(recoveryFor()),
      recovery.revealLinuxPackage(recoveryFor())
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(hashPasses.count).toBe(1)
  })

  it('revalidates once the in-flight pass settles', async () => {
    await writePackage('orca.deb')
    capture()
    await recovery.resolveLinuxPackageInstallInstructions(recoveryFor())
    await recovery.resolveLinuxPackageInstallInstructions(recoveryFor())
    expect(hashPasses.count).toBe(2)
  })

  // Why: a verdict handed to a root package manager must cover the bytes as of the click, not the
  // bytes a Copy click started streaming seconds earlier.
  it('never reuses an in-flight pass for a pre-install re-proof', async () => {
    await writePackage('orca.deb')
    capture()
    const artifact = recovery.getTrackedLinuxPackageArtifact()
    const copyPass = recovery.resolveLinuxPackageInstallInstructions(recoveryFor())
    const installPass = recovery.revalidateLinuxPackageForInstall(artifact!)

    await expect(installPass).resolves.toEqual({ ok: true })
    await expect(copyPass).resolves.toMatchObject({ ok: true })
    expect(hashPasses.count).toBe(2)
  })

  it('lets a later Copy click join the pre-install pass', async () => {
    await writePackage('orca.deb')
    capture()
    const artifact = recovery.getTrackedLinuxPackageArtifact()
    const installPass = recovery.revalidateLinuxPackageForInstall(artifact!)
    const copyPass = recovery.resolveLinuxPackageInstallInstructions(recoveryFor())

    await Promise.all([installPass, copyPass])
    expect(hashPasses.count).toBe(1)
  })

  it('does not reuse an in-flight pass for a different artifact', async () => {
    await writePackage('orca.deb')
    await writePackage('orca-next.deb')
    capture()
    const first = recovery.resolveLinuxPackageInstallInstructions(recoveryFor())
    capture({
      version: '1.2.4',
      downloadedFile: path.join(downloadDir, 'orca-next.deb'),
      files: [{ url: 'orca-next.deb', sha512: SHA512 }]
    })
    const second = recovery.resolveLinuxPackageInstallInstructions(
      recoveryFor({ version: '1.2.4' })
    )
    await Promise.all([first, second])
    expect(hashPasses.count).toBe(2)
  })
})

describePosix('revalidateLinuxPackageForInstall', () => {
  it('proves the retained package still matches its release digest', async () => {
    await writePackage('orca.deb')
    capture()
    const artifact = recovery.getTrackedLinuxPackageArtifact()
    await expect(recovery.revalidateLinuxPackageForInstall(artifact!)).resolves.toEqual({
      ok: true
    })
  })

  it('rejects a package swapped after the download was verified', async () => {
    await writePackage('orca.deb')
    capture()
    const artifact = recovery.getTrackedLinuxPackageArtifact()
    await writePackage('orca.deb', 'attacker supplied package')
    await expect(recovery.revalidateLinuxPackageForInstall(artifact!)).resolves.toEqual({
      ok: false,
      reason: 'hash-mismatch'
    })
  })

  it('reports a package deleted from the cache as missing', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    const artifact = recovery.getTrackedLinuxPackageArtifact()
    await fsp.rm(filePath)
    await expect(recovery.revalidateLinuxPackageForInstall(artifact!)).resolves.toEqual({
      ok: false,
      reason: 'missing'
    })
  })
})

describePosix('revealLinuxPackage', () => {
  it('reveals a verified package on the machine that owns it', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await expect(recovery.revealLinuxPackage(recoveryFor())).resolves.toEqual({ ok: true })
    expect(showItemInFolderMock).toHaveBeenCalledWith(filePath)
  })

  it('does not reveal a package that fails validation', async () => {
    const filePath = await writePackage('orca.deb')
    capture()
    await fsp.writeFile(filePath, 'tampered payload')
    await expect(recovery.revealLinuxPackage(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'hash-mismatch'
    })
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })

  it('reports read-failed when the desktop file manager throws', async () => {
    await writePackage('orca.deb')
    capture()
    showItemInFolderMock.mockImplementation(() => {
      throw new Error('no file manager available')
    })
    await expect(recovery.revealLinuxPackage(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'read-failed'
    })
  })

  it('does not reveal anything without a retained artifact', async () => {
    await expect(recovery.revealLinuxPackage(recoveryFor())).resolves.toEqual({
      ok: false,
      reason: 'missing'
    })
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })
})
