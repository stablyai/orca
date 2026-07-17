import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: injected cache composition tests must stay client-offline and never install Electron.
const electronNetFetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: electronNetFetchMock } }))

import {
  populateSshRelayArtifactCache,
  type SshRelayArtifactCachePopulationOperations
} from './ssh-relay-artifact-cache-population'
import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import {
  selectSshRelayArtifact,
  type SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const temporaryDirectories: string[] = []

function selectedArtifact(): SshRelaySelectedArtifact {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  const verified = verifySshRelayArtifactManifest(manifest, [
    { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
  ])
  const result = selectSshRelayArtifact(verified, {
    os: 'linux',
    architecture: 'x64',
    processTranslated: false,
    kernelVersion: '6.8',
    libc: { family: 'glibc', version: '2.39' },
    libstdcxxVersion: '6.0.33',
    glibcxxVersion: '3.4.33'
  })
  if (result.kind !== 'selected') {
    throw new Error('Expected a selected test artifact')
  }
  return result
}

async function testCacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-population-'))
  temporaryDirectories.push(root)
  return join(root, 'cache')
}

function cacheEntry(cacheRoot: string, artifact: SshRelaySelectedArtifact) {
  const entryPath = join(cacheRoot, 'entries', artifact.contentId.slice('sha256:'.length))
  return {
    contentId: artifact.contentId,
    tupleId: artifact.tupleId,
    entryPath,
    archivePath: join(entryPath, artifact.archive.name),
    runtimeRoot: join(entryPath, 'runtime'),
    proofPath: join(entryPath, 'proof.json'),
    files: artifact.archive.fileCount,
    expandedBytes: artifact.archive.expandedSize
  }
}

function lease(token = 'a'.repeat(32)) {
  return {
    leasePath: join(tmpdir(), 'in-use', token),
    token,
    assertOwned: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  }
}

const operations = {
  download: vi.fn<SshRelayArtifactCachePopulationOperations['download']>(),
  publish: vi.fn<SshRelayArtifactCachePopulationOperations['publish']>(),
  acquireInUseLease: vi.fn<SshRelayArtifactCachePopulationOperations['acquireInUseLease']>()
}

beforeEach(() => {
  electronNetFetchMock.mockReset()
  operations.download.mockReset()
  operations.publish.mockReset()
  operations.acquireInUseLease.mockReset()
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
  expect(electronNetFetchMock).not.toHaveBeenCalled()
})

async function expectEmptyDownloadStaging(cacheRoot: string): Promise<void> {
  await expect(readdir(join(cacheRoot, 'downloads'))).resolves.toEqual([])
}

describe('SSH relay artifact cache cold population', () => {
  it('downloads exclusively, publishes, cleans staging, and leases before exposure', async () => {
    const artifact = selectedArtifact()
    const cacheRoot = await testCacheRoot()
    const entry = cacheEntry(cacheRoot, artifact)
    const acquired = lease()
    const order: string[] = []
    let stagingArchive = ''
    operations.download.mockImplementation(async ({ destinationPath }) => {
      order.push('download')
      stagingArchive = destinationPath
      expect(destinationPath).toMatch(
        new RegExp(`[/\\\\]downloads[/\\\\][0-9a-f]{64}\\.pending-[^/\\\\]+[/\\\\]`)
      )
      expect(destinationPath.endsWith(artifact.archive.name)).toBe(true)
      await writeFile(destinationPath, 'verified download', { flag: 'wx' })
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size,
        sha256: artifact.archive.sha256
      }
    })
    operations.publish.mockImplementation(async ({ archivePath }) => {
      order.push('publish')
      expect(archivePath).toBe(stagingArchive)
      await expect(readFile(archivePath, 'utf8')).resolves.toBe('verified download')
      return entry
    })
    operations.acquireInUseLease.mockImplementation(async () => {
      order.push('lease')
      await expect(stat(stagingArchive)).rejects.toMatchObject({ code: 'ENOENT' })
      return acquired
    })

    const result = await populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)

    expect(order).toEqual(['download', 'publish', 'lease'])
    expect(result).toEqual({ artifact, entry, lease: acquired })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.entry)).toBe(true)
    await expectEmptyDownloadStaging(cacheRoot)
  })

  it('rejects a relative root before filesystem or artifact operations', async () => {
    await expect(
      populateSshRelayArtifactCache(
        { cacheRoot: 'relative/cache', artifact: selectedArtifact() },
        operations
      )
    ).rejects.toThrow(/absolute|cache root/i)
    expect(operations.download).not.toHaveBeenCalled()
    expect(operations.publish).not.toHaveBeenCalled()
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
  })

  it('rejects inconsistent download identity and removes its staging directory', async () => {
    const cacheRoot = await testCacheRoot()
    const artifact = selectedArtifact()
    operations.download.mockImplementation(async ({ destinationPath }) => {
      await writeFile(destinationPath, 'wrong download')
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size + 1,
        sha256: artifact.archive.sha256
      }
    })

    await expect(
      populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)
    ).rejects.toThrow(/download|identity|size/i)
    expect(operations.publish).not.toHaveBeenCalled()
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
    await expectEmptyDownloadStaging(cacheRoot)
  })

  it('cleans staging and propagates download or publication failures closed', async () => {
    const cacheRoot = await testCacheRoot()
    const artifact = selectedArtifact()
    operations.download.mockImplementationOnce(async ({ destinationPath }) => {
      await writeFile(destinationPath, 'partial download')
      throw new Error('certificate verification failed')
    })
    await expect(
      populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)
    ).rejects.toThrow(/certificate verification failed/i)
    expect(operations.publish).not.toHaveBeenCalled()
    await expectEmptyDownloadStaging(cacheRoot)

    operations.download.mockImplementationOnce(async ({ destinationPath }) => {
      await writeFile(destinationPath, 'verified download')
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size,
        sha256: artifact.archive.sha256
      }
    })
    operations.publish.mockRejectedValueOnce(new Error('extracted tree integrity failure'))
    await expect(
      populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)
    ).rejects.toThrow(/tree integrity failure/i)
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
    await expectEmptyDownloadStaging(cacheRoot)
  })

  it('propagates lease failure after cleaning staging', async () => {
    const cacheRoot = await testCacheRoot()
    const artifact = selectedArtifact()
    operations.download.mockImplementation(async ({ destinationPath }) => {
      await writeFile(destinationPath, 'verified download')
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size,
        sha256: artifact.archive.sha256
      }
    })
    operations.publish.mockResolvedValue(cacheEntry(cacheRoot, artifact))
    operations.acquireInUseLease.mockRejectedValue(new Error('entry evicted before lease'))

    await expect(
      populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)
    ).rejects.toThrow(/evicted before lease/i)
    await expectEmptyDownloadStaging(cacheRoot)
  })

  it('releases a lease when cancellation wins before the result is exposed', async () => {
    const cacheRoot = await testCacheRoot()
    const artifact = selectedArtifact()
    const controller = new AbortController()
    const acquired = lease('b'.repeat(32))
    operations.download.mockImplementation(async ({ destinationPath }) => {
      await writeFile(destinationPath, 'verified download')
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size,
        sha256: artifact.archive.sha256
      }
    })
    operations.publish.mockResolvedValue(cacheEntry(cacheRoot, artifact))
    operations.acquireInUseLease.mockImplementation(async () => {
      controller.abort(new Error('cancel after cold lease'))
      return acquired
    })

    await expect(
      populateSshRelayArtifactCache({ cacheRoot, artifact, signal: controller.signal }, operations)
    ).rejects.toThrow(/cancel after cold lease/i)
    expect(acquired.release).toHaveBeenCalledTimes(1)
    await expectEmptyDownloadStaging(cacheRoot)
  })

  it('uses different exclusive staging directories for concurrent populations', async () => {
    const cacheRoot = await testCacheRoot()
    const artifact = selectedArtifact()
    const destinations: string[] = []
    operations.download.mockImplementation(async ({ destinationPath }) => {
      destinations.push(destinationPath)
      await writeFile(destinationPath, 'verified download', { flag: 'wx' })
      return {
        destinationPath,
        finalUrl: artifact.archive.downloadUrl,
        size: artifact.archive.size,
        sha256: artifact.archive.sha256
      }
    })
    operations.publish.mockResolvedValue(cacheEntry(cacheRoot, artifact))
    operations.acquireInUseLease
      .mockResolvedValueOnce(lease('c'.repeat(32)))
      .mockResolvedValueOnce(lease('d'.repeat(32)))

    await expect(
      Promise.all([
        populateSshRelayArtifactCache({ cacheRoot, artifact }, operations),
        populateSshRelayArtifactCache({ cacheRoot, artifact }, operations)
      ])
    ).resolves.toHaveLength(2)
    expect(new Set(destinations)).toHaveLength(2)
    await expectEmptyDownloadStaging(cacheRoot)
  })
})
