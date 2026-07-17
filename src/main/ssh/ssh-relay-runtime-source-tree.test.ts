import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'

import type { SshRelayArtifactReadyAcquisition } from './ssh-relay-artifact-acquisition'
import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import type { SshRelayArtifactCacheInUseLease } from './ssh-relay-artifact-cache-in-use-lease'
import {
  createSshRelayArtifactTestManifest,
  createSshRelayWindowsArtifactTestManifest
} from './ssh-relay-artifact-test-manifest'
import { selectSshRelayArtifact } from './ssh-relay-artifact-selector'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'
import { computeSshRelayRuntimeContentId, type SshRelayDigest } from './ssh-relay-runtime-identity'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const cacheRoot = join(tmpdir(), 'orca-relay-runtime-source-tree')

type Fixture = {
  acquisition: SshRelayArtifactReadyAcquisition
  assertOwned: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function readyFixture(
  os: 'linux' | 'win32',
  { reverseEntries = false }: { reverseEntries?: boolean } = {}
): Fixture {
  const manifest =
    os === 'win32'
      ? createSshRelayWindowsArtifactTestManifest()
      : createSshRelayArtifactTestManifest()
  const tuple = manifest.tuples[0]
  if (reverseEntries) {
    tuple.entries.reverse()
    tuple.contentId = computeSshRelayRuntimeContentId(tuple)
    tuple.archive.name = sshRelayRuntimeArchiveName(tuple.tupleId, tuple.contentId)
  }
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  const verified = verifySshRelayArtifactManifest(manifest, [
    { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
  ])
  const host =
    os === 'win32'
      ? ({
          os,
          architecture: 'x64',
          processTranslated: false,
          build: 22631,
          openSshVersion: '9.5p1',
          powerShellVersion: '5.1',
          dotNetFrameworkRelease: 528040
        } as const)
      : ({
          os,
          architecture: 'x64',
          processTranslated: false,
          kernelVersion: '6.8',
          libc: { family: 'glibc', version: '2.39' },
          libstdcxxVersion: '6.0.33',
          glibcxxVersion: '3.4.33'
        } as const)
  const artifact = selectSshRelayArtifact(verified, host)
  if (artifact.kind !== 'selected') {
    throw new Error(`Expected selected source-tree fixture, got ${artifact.reason}`)
  }
  const entryPath = join(cacheRoot, 'entries', artifact.contentId.slice('sha256:'.length))
  const entry: SshRelayArtifactCacheEntry = {
    contentId: artifact.contentId,
    tupleId: artifact.tupleId,
    entryPath,
    archivePath: join(entryPath, artifact.archive.name),
    runtimeRoot: join(entryPath, 'runtime'),
    proofPath: join(entryPath, 'proof.json'),
    files: artifact.archive.fileCount,
    expandedBytes: artifact.archive.expandedSize
  }
  const assertOwned = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  const lease: SshRelayArtifactCacheInUseLease = {
    leasePath: join(cacheRoot, 'in-use', 'a'.repeat(32)),
    token: 'a'.repeat(32),
    assertOwned,
    release
  }
  return {
    acquisition: { kind: 'ready', source: 'cache', artifact, entry, lease },
    assertOwned,
    release
  }
}

function asciiSorted(paths: string[]): string[] {
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

const inconsistentCacheEntries: [string, Partial<SshRelayArtifactCacheEntry>][] = [
  ['tuple identity', { tupleId: 'win32-x64' }],
  ['content identity', { contentId: `sha256:${'f'.repeat(64)}` as SshRelayDigest }],
  ['file count', { files: 1 }],
  ['expanded byte count', { expandedBytes: 1 }]
]

describe('SSH relay runtime source-tree contract', () => {
  it.each(['linux', 'win32'] as const)(
    'projects an authenticated %s acquisition in immutable ASCII order',
    (os) => {
      const { acquisition } = readyFixture(os, { reverseEntries: true })

      const tree = createSshRelayRuntimeSourceTree(acquisition)

      const expectedDirectories = asciiSorted(
        acquisition.artifact.tuple.entries
          .filter((entry) => entry.type === 'directory')
          .map((entry) => entry.path)
      )
      const expectedFiles = asciiSorted(
        acquisition.artifact.tuple.entries
          .filter((entry) => entry.type === 'file')
          .map((entry) => entry.path)
      )
      expect(tree).toMatchObject({
        tupleId: acquisition.artifact.tupleId,
        contentId: acquisition.artifact.contentId,
        releaseTag: acquisition.artifact.releaseTag,
        os: acquisition.artifact.tuple.os,
        architecture: acquisition.artifact.tuple.architecture,
        runtimeRoot: acquisition.entry.runtimeRoot,
        fileCount: acquisition.entry.files,
        expandedBytes: acquisition.entry.expandedBytes
      })
      expect(tree.directories.map((entry) => entry.path)).toEqual(expectedDirectories)
      expect(tree.files.map((entry) => entry.path)).toEqual(expectedFiles)
      for (const descriptor of [...tree.directories, ...tree.files]) {
        expect(descriptor.localPath).toBe(
          join(acquisition.entry.runtimeRoot, ...descriptor.path.split('/'))
        )
      }
      expect(tree.files).toEqual(
        expectedFiles.map((path) => {
          const entry = acquisition.artifact.tuple.entries.find(
            (candidate) => candidate.path === path
          )
          if (!entry || entry.type !== 'file') {
            throw new Error(`Missing expected signed file: ${path}`)
          }
          return {
            path,
            localPath: join(acquisition.entry.runtimeRoot, ...path.split('/')),
            type: 'file',
            role: entry.role,
            size: entry.size,
            mode: entry.mode,
            sha256: entry.sha256
          }
        })
      )
    }
  )

  it('deeply freezes descriptors without mutating signed manifest insertion order', () => {
    const { acquisition } = readyFixture('linux')
    const originalOrder = acquisition.artifact.tuple.entries.map((entry) => entry.path)

    const tree = createSshRelayRuntimeSourceTree(acquisition)

    expect(Object.isFrozen(tree)).toBe(true)
    expect(Object.isFrozen(tree.directories)).toBe(true)
    expect(Object.isFrozen(tree.files)).toBe(true)
    expect(tree.directories.every(Object.isFrozen)).toBe(true)
    expect(tree.files.every(Object.isFrozen)).toBe(true)
    expect(acquisition.artifact.tuple.entries.map((entry) => entry.path)).toEqual(originalOrder)
  })

  it('borrows lease ownership without asserting or releasing it implicitly', async () => {
    const { acquisition, assertOwned, release } = readyFixture('linux')

    const tree = createSshRelayRuntimeSourceTree(acquisition)

    expect(assertOwned).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    await tree.assertLeaseOwned()
    expect(assertOwned).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
  })

  it('rejects a non-ready acquisition', () => {
    expect(() =>
      createSshRelayRuntimeSourceTree({
        kind: 'legacy',
        reason: 'kernel-too-old'
      } as unknown as SshRelayArtifactReadyAcquisition)
    ).toThrow(/ready/i)
  })

  it.each(inconsistentCacheEntries)('rejects inconsistent cache %s', (_name, entryPatch) => {
    const { acquisition } = readyFixture('linux')

    expect(() =>
      createSshRelayRuntimeSourceTree({
        ...acquisition,
        entry: { ...acquisition.entry, ...entryPatch }
      })
    ).toThrow(/identity|file count|expanded byte/i)
  })

  it('rejects a noncanonical cache runtime root', () => {
    const { acquisition } = readyFixture('linux')

    expect(() =>
      createSshRelayRuntimeSourceTree({
        ...acquisition,
        entry: { ...acquisition.entry, runtimeRoot: join(acquisition.entry.entryPath, 'other') }
      })
    ).toThrow(/runtime root/i)
  })
})
