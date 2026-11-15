import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { LinuxPackageInstallRecovery } from '../../../shared/update-status-types'
import type { LinuxPackageArtifact } from './linux-package-update-recovery'
import type * as RecoveryModule from './linux-package-update-recovery'

const { getPackageTypeMock, buildCommandMock, hashPasses } = vi.hoisted(() => ({
  getPackageTypeMock: vi.fn(),
  buildCommandMock: vi.fn(),
  hashPasses: { count: 0 }
}))

vi.mock('./linux-update-package-type', () => ({ getLinuxRootPackageType: getPackageTypeMock }))

vi.mock('./linux-package-install-command', () => ({
  buildLinuxPackageInstallCommand: buildCommandMock
}))

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

// These fixtures require POSIX modes, symlinks, and XDG cache paths.
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

function capture(overrides: Record<string, unknown> = {}): LinuxPackageArtifact | null {
  const downloadedFile = (overrides.downloadedFile ?? path.join(downloadDir, 'orca.deb')) as string
  return recovery.captureLinuxPackageArtifact({
    version: VERSION,
    files: [{ url: path.basename(downloadedFile), sha512: SHA512 }],
    ...overrides,
    downloadedFile
  })
}

beforeEach(async () => {
  vi.resetModules()
  hashPasses.count = 0
  getPackageTypeMock.mockReset().mockReturnValue('deb')
  buildCommandMock.mockReset().mockReturnValue({ ok: true, command: 'installed command' })
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-recovery-'))
  cacheRoot = path.join(tempRoot, 'cache')
  updaterDir = path.join(cacheRoot, 'orca-updater')
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
  it('ignores the event on a build that is not a root package', () => {
    getPackageTypeMock.mockReturnValue(null)
    capture()
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('requires an absolute downloaded path', () => {
    capture({ downloadedFile: 'orca.deb' })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('requires the package extension to match the installed format', () => {
    capture({ downloadedFile: path.join(downloadDir, 'orca.rpm') })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
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

  it('refuses an ambiguous basename with two different digests', () => {
    capture({
      files: [
        { url: 'orca.deb', sha512: SHA512 },
        { url: 'https://mirror.example.com/orca.deb', sha512: 'conflicting-digest' }
      ]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a digest that cannot decode to 64 bytes', () => {
    // Invalid release metadata must not arm recovery that blames the downloaded file.
    capture({
      files: [{ url: 'orca.deb', sha512: createHash('sha256').update(PAYLOAD).digest('base64') }]
    })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('refuses a digest with characters outside the base64 alphabet', () => {
    // Buffer.from silently drops invalid characters unless checked by a round trip.
    capture({ files: [{ url: 'orca.deb', sha512: `${SHA512.slice(0, 4)}!${SHA512.slice(4)}` }] })
    expect(recovery.getTrackedLinuxPackageArtifact()).toBeNull()
  })

  it('keeps a retained artifact when a later event carries a malformed digest', () => {
    capture()
    expect(capture({ files: [{ url: 'orca.deb', sha512: 'not-a-digest' }] })).toBeNull()
    expect(recovery.getTrackedLinuxPackageArtifact()?.sha512).toBe(SHA512)
  })
})

describePosix('resolveLinuxPackageInstallInstructions', () => {
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
})

// Pending-directory shape is defense in depth; cache-root containment excludes other users’ swap locations.
describePosix('pending-directory anchoring', () => {
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
