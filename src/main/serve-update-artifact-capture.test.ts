import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FILE_CONTENT = 'appimage-bytes'
// Computed from the actual file content so the hash check passes.
const SHA512 = createHash('sha512').update(FILE_CONTENT).digest('base64')

describe('serve update artifact capture', () => {
  let tempRoot: string
  let downloadDir: string

  beforeEach(async () => {
    vi.resetModules()
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-serve-capture-'))
    const cacheRoot = path.join(tempRoot, 'cache')
    const updaterDir = path.join(cacheRoot, 'orca-updater')
    downloadDir = path.join(updaterDir, 'pending')
    await fsp.mkdir(downloadDir, { recursive: true })
    process.env.XDG_CACHE_HOME = cacheRoot
  })

  afterEach(async () => {
    delete process.env.XDG_CACHE_HOME
    await fsp.rm(tempRoot, { recursive: true, force: true })
  })

  it('accepts a valid AppImage inside the updater pending directory', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, FILE_CONTENT)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: SHA512 }]
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a file outside the updater cache', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const outside = path.join(tempRoot, 'evil.AppImage')
    await fsp.writeFile(outside, FILE_CONTENT)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: outside,
      files: [{ url: 'evil.AppImage', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('rejects a hash mismatch', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, 'tampered')
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'hash-mismatch' })
  })

  it('rejects missing metadata', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    expect(await captureServeUpdateAppImage({})).toEqual({ ok: false, reason: 'missing-metadata' })
  })

  it('rejects a non-AppImage artifact', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.deb')
    await fsp.writeFile(artifactPath, 'deb-bytes')
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.deb', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'not-appimage' })
  })

  it('rejects a symlinked artifact', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const realFile = path.join(tempRoot, 'real.AppImage')
    await fsp.writeFile(realFile, FILE_CONTENT)
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.AppImage')
    await fsp.symlink(realFile, artifactPath)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('rejects a symlinked pending directory that resolves outside the cache', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const evilRoot = path.join(tempRoot, 'evil')
    await fsp.mkdir(evilRoot, { recursive: true })
    const artifactPath = path.join(evilRoot, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, FILE_CONTENT)
    // Same-uid attacker swaps the pending directory for a symlink at the real
    // cache location: realpath must walk through it and reject the escape.
    const realPending = path.join(tempRoot, 'cache', 'orca-updater', 'pending')
    await fsp.rm(realPending, { recursive: true })
    await fsp.symlink(evilRoot, realPending)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('rejects a URL-safe base64 digest', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, FILE_CONTENT)
    const urlSafe = SHA512.replaceAll('+', '-').replaceAll('/', '_')
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: urlSafe }]
    })
    // Buffer.from would silently decode the URL-safe form; only the round-trip
    // check catches it, and an unrecognized encoding must fail closed.
    expect(result).toEqual({ ok: false, reason: 'missing-metadata' })
  })

  it('rejects a traversal path into the pending directory name', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const outside = path.join(tempRoot, 'pending')
    await fsp.mkdir(outside, { recursive: true })
    const artifactPath = path.join(outside, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, FILE_CONTENT)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [{ url: 'orca-1.4.198.AppImage', sha512: SHA512 }]
    })
    expect(result).toEqual({ ok: false, reason: 'not-regular' })
  })

  it('rejects an ambiguous digest pairing', async () => {
    const { captureServeUpdateAppImage } = await import('./serve-update-artifact-capture')
    const artifactPath = path.join(downloadDir, 'orca-1.4.198.AppImage')
    await fsp.writeFile(artifactPath, FILE_CONTENT)
    const result = await captureServeUpdateAppImage({
      version: '1.4.198',
      downloadedFile: artifactPath,
      files: [
        { url: 'orca-1.4.198.AppImage', sha512: SHA512 },
        { url: 'orca-1.4.198.AppImage', sha512: `${'B'.repeat(86)}==` }
      ]
    })
    expect(result).toEqual({ ok: false, reason: 'missing-metadata' })
  })
})
