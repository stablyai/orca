import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import nacl from 'tweetnacl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import { SshRelayArtifactCacheIntegrityError } from './ssh-relay-artifact-cache-entry'
import {
  resolveSshRelayArtifactCache,
  type SshRelayArtifactCacheResolutionOperations
} from './ssh-relay-artifact-cache-resolution'
import type { SshRelayOfficialManifest } from './ssh-relay-official-manifest'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const cacheRoot = join(tmpdir(), 'orca-relay-cache-resolution')
const compatibleHost = {
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

function cacheEntryFor(official: SshRelayOfficialManifest) {
  const tuple = official.manifest.tuples[0]
  return {
    contentId: tuple.contentId,
    tupleId: tuple.tupleId,
    entryPath: join(cacheRoot, 'entries', tuple.contentId.slice('sha256:'.length)),
    archivePath: join(cacheRoot, tuple.archive.name),
    runtimeRoot: join(cacheRoot, 'runtime'),
    proofPath: join(cacheRoot, 'install-proof.json'),
    files: tuple.entries.length,
    expandedBytes: tuple.entries.reduce(
      (total, value) => total + (value.type === 'file' ? value.size : 0),
      0
    )
  }
}

const operations = {
  lookup: vi.fn<SshRelayArtifactCacheResolutionOperations['lookup']>(),
  acquireInUseLease: vi.fn<SshRelayArtifactCacheResolutionOperations['acquireInUseLease']>()
}

beforeEach(() => {
  operations.lookup.mockReset()
  operations.acquireInUseLease.mockReset()
})

describe('SSH relay artifact cache resolution', () => {
  it('returns unavailable before cache I/O when official trust is unprovisioned', async () => {
    await expect(
      resolveSshRelayArtifactCache(
        { officialManifest: null, host: compatibleHost, cacheRoot },
        operations
      )
    ).resolves.toEqual({ kind: 'unavailable', reason: 'official-manifest-unavailable' })
    expect(operations.lookup).not.toHaveBeenCalled()
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
  })

  it('returns a compatibility legacy result before cache I/O', async () => {
    await expect(
      resolveSshRelayArtifactCache(
        {
          officialManifest: officialManifest(),
          host: { ...compatibleHost, processTranslated: true },
          cacheRoot
        },
        operations
      )
    ).resolves.toEqual({ kind: 'legacy', reason: 'translated-process' })
    expect(operations.lookup).not.toHaveBeenCalled()
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
  })

  it('returns an immutable selected artifact on cache miss without acquiring a lease', async () => {
    operations.lookup.mockResolvedValue({ kind: 'miss' })

    const result = await resolveSshRelayArtifactCache(
      { officialManifest: officialManifest(), host: compatibleHost, cacheRoot },
      operations
    )

    expect(result).toMatchObject({ kind: 'cache-miss', artifact: { tupleId: 'linux-x64-glibc' } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(operations.lookup).toHaveBeenCalledTimes(1)
    expect(operations.lookup.mock.calls[0][0]).toMatchObject({ cacheRoot })
    expect(operations.acquireInUseLease).not.toHaveBeenCalled()
  })

  it('uses the real verified cache lookup on a disconnected miss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-resolution-real-'))
    try {
      await expect(
        resolveSshRelayArtifactCache({
          officialManifest: officialManifest(),
          host: compatibleHost,
          cacheRoot: join(root, 'cache')
        })
      ).resolves.toMatchObject({
        kind: 'cache-miss',
        artifact: { tupleId: 'linux-x64-glibc' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('acquires a lease before exposing a frozen verified cache entry', async () => {
    const official = officialManifest()
    const entry = cacheEntryFor(official)
    const lease = {
      leasePath: join(cacheRoot, 'in-use', 'lease'),
      token: 'b'.repeat(32),
      assertOwned: vi.fn(async () => {}),
      release: vi.fn(async () => {})
    }
    operations.lookup.mockResolvedValue({ kind: 'hit', entry })
    operations.acquireInUseLease.mockResolvedValue(lease)

    const result = await resolveSshRelayArtifactCache(
      { officialManifest: official, host: compatibleHost, cacheRoot },
      operations
    )

    expect(result).toMatchObject({ kind: 'cache-hit', entry, lease })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.kind === 'cache-hit' && Object.isFrozen(result.entry)).toBe(true)
    expect(operations.acquireInUseLease).toHaveBeenCalledTimes(1)
    expect(operations.acquireInUseLease.mock.calls[0][0]).toMatchObject({ cacheRoot, entry })
    expect(operations.lookup.mock.invocationCallOrder[0]).toBeLessThan(
      operations.acquireInUseLease.mock.invocationCallOrder[0]
    )
  })

  it('releases an acquired lease when cancellation wins before exposure', async () => {
    const official = officialManifest()
    const controller = new AbortController()
    const release = vi.fn(async () => {})
    operations.lookup.mockResolvedValue({ kind: 'hit', entry: cacheEntryFor(official) })
    operations.acquireInUseLease.mockImplementation(async () => {
      controller.abort(new Error('cancel after lease'))
      return {
        leasePath: join(cacheRoot, 'in-use', 'lease'),
        token: 'c'.repeat(32),
        assertOwned: vi.fn(async () => {}),
        release
      }
    })

    await expect(
      resolveSshRelayArtifactCache(
        {
          officialManifest: official,
          host: compatibleHost,
          cacheRoot,
          signal: controller.signal
        },
        operations
      )
    ).rejects.toThrow(/cancel after lease/i)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rejects a relative cache root before invoking cache operations', async () => {
    await expect(
      resolveSshRelayArtifactCache(
        {
          officialManifest: officialManifest(),
          host: compatibleHost,
          cacheRoot: 'relative/cache'
        },
        operations
      )
    ).rejects.toThrow(/absolute|cache root/i)
    expect(operations.lookup).not.toHaveBeenCalled()
  })

  it('settles pre-aborted requests without invoking cache operations', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancel cache resolution'))

    await expect(
      resolveSshRelayArtifactCache(
        {
          officialManifest: officialManifest(),
          host: compatibleHost,
          cacheRoot,
          signal: controller.signal
        },
        operations
      )
    ).rejects.toThrow(/cancel cache resolution/i)
    expect(operations.lookup).not.toHaveBeenCalled()
  })

  it('propagates cache integrity and lease failures without returning miss or legacy', async () => {
    operations.lookup.mockRejectedValueOnce(
      new SshRelayArtifactCacheIntegrityError(
        'corrupt cache entry',
        join(cacheRoot, 'quarantine', 'corrupt'),
        new Error('tree mismatch')
      )
    )
    await expect(
      resolveSshRelayArtifactCache(
        { officialManifest: officialManifest(), host: compatibleHost, cacheRoot },
        operations
      )
    ).rejects.toBeInstanceOf(SshRelayArtifactCacheIntegrityError)

    const official = officialManifest()
    operations.lookup.mockResolvedValueOnce({
      kind: 'hit',
      entry: cacheEntryFor(official)
    })
    operations.acquireInUseLease.mockRejectedValueOnce(new Error('lease ownership displaced'))
    await expect(
      resolveSshRelayArtifactCache(
        { officialManifest: official, host: compatibleHost, cacheRoot },
        operations
      )
    ).rejects.toThrow(/lease ownership displaced/i)
  })
})
