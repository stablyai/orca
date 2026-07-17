import { join } from 'node:path'
import { tmpdir } from 'node:os'

import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: injected cache composition tests must stay client-offline and never install Electron.
const electronNetFetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: electronNetFetchMock } }))

import {
  acquireSshRelayArtifact,
  type SshRelayArtifactAcquisitionOperations
} from './ssh-relay-artifact-acquisition'
import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import type { SshRelayArtifactCacheInUseLease } from './ssh-relay-artifact-cache-in-use-lease'
import {
  selectSshRelayArtifact,
  type SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import type { SshRelayOfficialManifest } from './ssh-relay-official-manifest'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const cacheRoot = join(tmpdir(), 'orca-relay-artifact-acquisition')
const host = {
  os: 'linux' as const,
  architecture: 'x64' as const,
  processTranslated: false,
  kernelVersion: '6.8.0',
  libc: { family: 'glibc' as const, version: '2.39' },
  libstdcxxVersion: '6.0.33',
  glibcxxVersion: '3.4.33'
}

function officialManifest(): SshRelayOfficialManifest {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  return Object.freeze({
    manifest: verifySshRelayArtifactManifest(manifest, [
      { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
    ]),
    acceptedKeysSha256: `sha256:${'a'.repeat(64)}` as SshRelayDigest
  })
}

function artifact(official: SshRelayOfficialManifest): SshRelaySelectedArtifact {
  const selected = selectSshRelayArtifact(official.manifest, host)
  if (selected.kind !== 'selected') {
    throw new Error(`Expected selected acquisition fixture, got ${selected.reason}`)
  }
  return selected
}

function entryFor(selected: ReturnType<typeof artifact>): SshRelayArtifactCacheEntry {
  const entryPath = join(cacheRoot, 'entries', selected.contentId.slice('sha256:'.length))
  return {
    contentId: selected.contentId,
    tupleId: selected.tupleId,
    entryPath,
    archivePath: join(entryPath, selected.archive.name),
    runtimeRoot: join(entryPath, 'runtime'),
    proofPath: join(entryPath, 'proof.json'),
    files: selected.archive.fileCount,
    expandedBytes: selected.archive.expandedSize
  }
}

function lease(token = 'b'.repeat(32)): SshRelayArtifactCacheInUseLease {
  return {
    leasePath: join(cacheRoot, 'in-use', token),
    token,
    assertOwned: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  }
}

const operations = {
  resolve: vi.fn<SshRelayArtifactAcquisitionOperations['resolve']>(),
  populate: vi.fn<SshRelayArtifactAcquisitionOperations['populate']>()
}

beforeEach(() => {
  electronNetFetchMock.mockReset()
  operations.resolve.mockReset()
  operations.populate.mockReset()
})

afterEach(() => {
  expect(electronNetFetchMock).not.toHaveBeenCalled()
})

describe('SSH relay artifact warm/cold acquisition', () => {
  it('returns unavailable without attempting cold population', async () => {
    operations.resolve.mockResolvedValue({
      kind: 'unavailable',
      reason: 'official-manifest-unavailable'
    })

    const result = await acquireSshRelayArtifact(
      { officialManifest: null, host, cacheRoot },
      operations
    )

    expect(result).toEqual({ kind: 'unavailable', reason: 'official-manifest-unavailable' })
    expect(Object.isFrozen(result)).toBe(true)
    expect(operations.populate).not.toHaveBeenCalled()
  })

  it('returns compatibility legacy without attempting cold population', async () => {
    operations.resolve.mockResolvedValue({ kind: 'legacy', reason: 'kernel-too-old' })

    await expect(
      acquireSshRelayArtifact({ officialManifest: officialManifest(), host, cacheRoot }, operations)
    ).resolves.toEqual({ kind: 'legacy', reason: 'kernel-too-old' })
    expect(operations.populate).not.toHaveBeenCalled()
  })

  it('maps a warm hit to a frozen cache-sourced leased result without download', async () => {
    const official = officialManifest()
    const selected = artifact(official)
    const entry = entryFor(selected)
    const acquired = lease()
    operations.resolve.mockResolvedValue({
      kind: 'cache-hit',
      artifact: selected,
      entry,
      lease: acquired
    })

    const result = await acquireSshRelayArtifact(
      { officialManifest: official, host, cacheRoot },
      operations
    )

    expect(result).toEqual({
      kind: 'ready',
      source: 'cache',
      artifact: selected,
      entry,
      lease: acquired
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.kind === 'ready' && Object.isFrozen(result.entry)).toBe(true)
    expect(operations.populate).not.toHaveBeenCalled()
  })

  it('populates exactly once after a verified miss and returns a download-sourced lease', async () => {
    const official = officialManifest()
    const selected = artifact(official)
    const entry = entryFor(selected)
    const acquired = lease('c'.repeat(32))
    operations.resolve.mockResolvedValue({ kind: 'cache-miss', artifact: selected })
    operations.populate.mockResolvedValue({ artifact: selected, entry, lease: acquired })

    const result = await acquireSshRelayArtifact(
      { officialManifest: official, host, cacheRoot },
      operations
    )

    expect(result).toMatchObject({ kind: 'ready', source: 'download', artifact: selected, entry })
    expect(operations.resolve).toHaveBeenCalledTimes(1)
    expect(operations.populate).toHaveBeenCalledTimes(1)
    expect(operations.populate).toHaveBeenCalledWith({
      cacheRoot,
      artifact: selected,
      signal: undefined
    })
    expect(operations.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      operations.populate.mock.invocationCallOrder[0]
    )
  })

  it('settles a pre-aborted request before resolution', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancel artifact acquisition'))

    await expect(
      acquireSshRelayArtifact(
        {
          officialManifest: officialManifest(),
          host,
          cacheRoot,
          signal: controller.signal
        },
        operations
      )
    ).rejects.toThrow(/cancel artifact acquisition/i)
    expect(operations.resolve).not.toHaveBeenCalled()
  })

  it.each(['cache', 'download'] as const)(
    'releases a %s lease when cancellation wins before exposure',
    async (source) => {
      const official = officialManifest()
      const selected = artifact(official)
      const entry = entryFor(selected)
      const acquired = lease(source === 'cache' ? 'd'.repeat(32) : 'e'.repeat(32))
      const controller = new AbortController()
      if (source === 'cache') {
        operations.resolve.mockImplementation(async () => {
          controller.abort(new Error('cancel after warm lease'))
          return { kind: 'cache-hit', artifact: selected, entry, lease: acquired }
        })
      } else {
        operations.resolve.mockResolvedValue({ kind: 'cache-miss', artifact: selected })
        operations.populate.mockImplementation(async () => {
          controller.abort(new Error('cancel after cold lease'))
          return { artifact: selected, entry, lease: acquired }
        })
      }

      await expect(
        acquireSshRelayArtifact(
          { officialManifest: official, host, cacheRoot, signal: controller.signal },
          operations
        )
      ).rejects.toThrow(source === 'cache' ? /warm lease/i : /cold lease/i)
      expect(acquired.release).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects inconsistent cold identity and releases the acquired lease', async () => {
    const official = officialManifest()
    const selected = artifact(official)
    const entry = entryFor(selected)
    const acquired = lease('f'.repeat(32))
    operations.resolve.mockResolvedValue({ kind: 'cache-miss', artifact: selected })
    operations.populate.mockResolvedValue({
      artifact: selected,
      entry: { ...entry, tupleId: 'win32-x64' },
      lease: acquired
    })

    await expect(
      acquireSshRelayArtifact({ officialManifest: official, host, cacheRoot }, operations)
    ).rejects.toThrow(/identity|tuple|content/i)
    expect(acquired.release).toHaveBeenCalledTimes(1)
  })

  it('propagates warm resolution and cold population failures without classification', async () => {
    operations.resolve.mockRejectedValueOnce(new Error('cache integrity failure'))
    await expect(
      acquireSshRelayArtifact({ officialManifest: officialManifest(), host, cacheRoot }, operations)
    ).rejects.toThrow(/cache integrity failure/i)

    const official = officialManifest()
    operations.resolve.mockResolvedValueOnce({
      kind: 'cache-miss',
      artifact: artifact(official)
    })
    operations.populate.mockRejectedValueOnce(new Error('certificate verification failed'))
    await expect(
      acquireSshRelayArtifact({ officialManifest: official, host, cacheRoot }, operations)
    ).rejects.toThrow(/certificate verification failed/i)
  })
})
