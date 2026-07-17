import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  lookupSshRelayArtifactCacheEntry,
  publishSshRelayArtifactCacheEntry,
  SshRelayArtifactCacheIntegrityError,
  sshRelayArtifactCacheEntryPath,
  SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS
} from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import { SSH_RELAY_ARTIFACT_CACHE_ENTRY_VERIFICATION_LIMITS } from './ssh-relay-artifact-cache-entry-verification'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const temporaryDirectories: string[] = []

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-entry-'))
  temporaryDirectories.push(root)
  return root
}

async function entryFixture(os: 'linux' | 'win32' = 'linux') {
  const root = await testRoot()
  return {
    root,
    cacheRoot: join(root, 'cache'),
    ...(await createSshRelayArtifactCacheEntryFixture({ root, os }))
  }
}

async function entryChildren(cacheRoot: string): Promise<string[]> {
  return readdir(join(cacheRoot, 'entries')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  })
}

async function expectIntegrityQuarantine(options: {
  cacheRoot: string
  artifact: Awaited<ReturnType<typeof entryFixture>>['artifact']
}): Promise<SshRelayArtifactCacheIntegrityError> {
  const error = await lookupSshRelayArtifactCacheEntry(options).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(SshRelayArtifactCacheIntegrityError)
  const integrity = error as SshRelayArtifactCacheIntegrityError
  expect(integrity.quarantinePath).toBeTruthy()
  await expect(
    stat(sshRelayArtifactCacheEntryPath(options.cacheRoot, options.artifact.contentId))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(integrity.quarantinePath!)).resolves.toMatchObject({
    isDirectory: expect.any(Function)
  })
  return integrity
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay immutable artifact cache entry', () => {
  it('pins bounded transaction, copy, hash, and proof limits', () => {
    expect(SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS).toEqual({
      transactionTimeoutMs: 5 * 60_000,
      maximumIncrementalMemoryBytes: 80 * 1024 * 1024
    })
    expect(SSH_RELAY_ARTIFACT_CACHE_ENTRY_VERIFICATION_LIMITS).toEqual({
      chunkBytes: 64 * 1024,
      proofMaxBytes: 16 * 1024
    })
  })

  it('derives the final entry only from an exact lowercase content digest', async () => {
    const root = await testRoot()
    const contentId = `sha256:${'a'.repeat(64)}` as SshRelayDigest
    expect(sshRelayArtifactCacheEntryPath(root, contentId)).toBe(
      join(root, 'entries', 'a'.repeat(64))
    )
    for (const invalid of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(64)}/../escape`,
      'a'.repeat(64)
    ]) {
      expect(() => sshRelayArtifactCacheEntryPath(root, invalid as SshRelayDigest)).toThrow(
        /content id/i
      )
    }
  })

  it.each(['linux', 'win32'] as const)(
    'publishes and revalidates one complete immutable %s entry',
    async (os) => {
      const value = await entryFixture(os)
      const published = await publishSshRelayArtifactCacheEntry(value)

      expect(published).toMatchObject({
        contentId: value.artifact.contentId,
        tupleId: value.artifact.tupleId,
        files: value.artifact.archive.fileCount,
        expandedBytes: value.artifact.archive.expandedSize
      })
      expect((await readdir(published.entryPath)).sort()).toEqual(
        [value.artifact.archive.name, 'proof.json', 'runtime'].sort()
      )
      for (const [path, bytes] of value.fileBytes) {
        expect(await readFile(join(published.runtimeRoot, ...path.split('/')))).toEqual(bytes)
      }
      const lookup = await lookupSshRelayArtifactCacheEntry(value)
      expect(lookup).toEqual({ kind: 'hit', entry: published })
      expect(await entryChildren(value.cacheRoot)).toEqual([value.artifact.contentId.slice(7)])
    }
  )

  it('returns an exact miss without creating or quarantining state', async () => {
    const value = await entryFixture()
    await expect(lookupSshRelayArtifactCacheEntry(value)).resolves.toEqual({ kind: 'miss' })
    expect(await entryChildren(value.cacheRoot)).toEqual([])
  })

  it('never exposes a final entry when archive verification or cancellation fails', async () => {
    const corrupt = await entryFixture()
    const bytes = await readFile(corrupt.archivePath)
    bytes[0] ^= 0x01
    await writeFile(corrupt.archivePath, bytes)
    await expect(publishSshRelayArtifactCacheEntry(corrupt)).rejects.toThrow(/archive|sha|hash/i)
    expect(await entryChildren(corrupt.cacheRoot)).toEqual([])

    const cancelled = await entryFixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel cache publication'))
    await expect(
      publishSshRelayArtifactCacheEntry({ ...cancelled, signal: controller.signal })
    ).rejects.toThrow(/cancel cache publication/i)
    expect(await entryChildren(cancelled.cacheRoot)).toEqual([])
  })

  it('serializes concurrent publishers and reuses a valid immutable entry', async () => {
    const value = await entryFixture()
    const [first, second] = await Promise.all([
      publishSshRelayArtifactCacheEntry(value),
      publishSshRelayArtifactCacheEntry(value)
    ])
    expect(second).toEqual(first)
    const before = await stat(first.proofPath)
    await expect(publishSshRelayArtifactCacheEntry(value)).resolves.toEqual(first)
    expect((await stat(first.proofPath)).mtimeMs).toBe(before.mtimeMs)
    expect(await entryChildren(value.cacheRoot)).toEqual([value.artifact.contentId.slice(7)])
  })

  it('cleans only same-content stale staging after acquiring ownership', async () => {
    const value = await entryFixture()
    const finalPath = sshRelayArtifactCacheEntryPath(value.cacheRoot, value.artifact.contentId)
    const stalePath = `${finalPath}.pending-${'f'.repeat(32)}`
    await mkdir(stalePath, { recursive: true })
    await writeFile(join(stalePath, 'partial'), 'not selectable')

    await publishSshRelayArtifactCacheEntry(value)

    await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await entryChildren(value.cacheRoot)).toEqual([value.artifact.contentId.slice(7)])
  })

  it.each([
    ['proof', async (entryPath: string) => writeFile(join(entryPath, 'proof.json'), '{}')],
    [
      'proof identity',
      async (entryPath: string) => {
        const proofPath = join(entryPath, 'proof.json')
        const proof = JSON.parse(await readFile(proofPath, 'utf8')) as Record<string, unknown>
        await writeFile(proofPath, `${JSON.stringify({ ...proof, releaseTag: 'v0.0.0' })}\n`)
      }
    ],
    [
      'proof unknown field',
      async (entryPath: string) => {
        const proofPath = join(entryPath, 'proof.json')
        const proof = JSON.parse(await readFile(proofPath, 'utf8')) as Record<string, unknown>
        await writeFile(proofPath, `${JSON.stringify({ ...proof, latest: true })}\n`)
      }
    ],
    [
      'archive',
      async (entryPath: string, archiveName: string) =>
        writeFile(join(entryPath, archiveName), 'changed archive bytes')
    ],
    [
      'runtime file',
      async (entryPath: string) => writeFile(join(entryPath, 'runtime', 'relay.js'), 'changed')
    ],
    [
      'unexpected member',
      async (entryPath: string) => writeFile(join(entryPath, 'unexpected'), 'partial state')
    ],
    ['missing member', async (entryPath: string) => rm(join(entryPath, 'runtime', 'relay.js'))]
  ] as const)('quarantines %s corruption instead of returning a miss', async (_name, mutate) => {
    const value = await entryFixture()
    const entry = await publishSshRelayArtifactCacheEntry(value)
    await mutate(entry.entryPath, value.artifact.archive.name)

    await expectIntegrityQuarantine(value)
  })

  it('quarantines a partial final entry', async () => {
    const value = await entryFixture()
    const entryPath = sshRelayArtifactCacheEntryPath(value.cacheRoot, value.artifact.contentId)
    await mkdir(entryPath, { recursive: true })
    await writeFile(join(entryPath, 'partial'), 'crash residue')

    await expectIntegrityQuarantine(value)
  })

  it('recovers corrupt existing state only from freshly reverified bytes', async () => {
    const value = await entryFixture()
    const first = await publishSshRelayArtifactCacheEntry(value)
    await writeFile(join(first.runtimeRoot, 'relay.js'), 'changed')

    const replacement = await publishSshRelayArtifactCacheEntry(value)

    expect(replacement.entryPath).toBe(first.entryPath)
    await expect(lookupSshRelayArtifactCacheEntry(value)).resolves.toEqual({
      kind: 'hit',
      entry: replacement
    })
    expect(await readdir(join(value.cacheRoot, 'quarantine'))).toHaveLength(1)
  })
})
