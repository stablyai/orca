import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import * as runtimeArchive from './ssh-relay-runtime-archive.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

const temporaryDirectories = []

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function archiveName(identity) {
  return `orca-ssh-relay-runtime-v1-${identity.tupleId}-${identity.contentId.slice('sha256:'.length)}.tar.br`
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-relay-portable-archive-'))
  temporaryDirectories.push(root)
  const runtimeRoot = join(root, 'runtime')
  const outputDirectory = join(root, 'output')
  const nodeBytes = Buffer.from('portable bundled node')
  await Promise.all([mkdir(join(runtimeRoot, 'bin'), { recursive: true }), mkdir(outputDirectory)])
  await writeFile(join(runtimeRoot, 'bin', 'node'), nodeBytes)
  await chmod(join(runtimeRoot, 'bin', 'node'), 0o755)
  const base = {
    tupleId: 'darwin-arm64',
    os: 'darwin',
    architecture: 'arm64',
    compatibility: { kind: 'darwin', minimumVersion: '13.5' },
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: [
      { path: 'bin', type: 'directory', mode: 0o755 },
      {
        path: 'bin/node',
        type: 'file',
        role: 'node',
        size: nodeBytes.length,
        mode: 0o755,
        sha256: digest(nodeBytes)
      }
    ],
    fileCount: 1,
    expandedSize: nodeBytes.length
  }
  return {
    runtimeRoot,
    outputDirectory,
    identity: { ...base, contentId: computeSshRelayRuntimeContentId(base) }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay portable POSIX archive', () => {
  it.skipIf(process.platform === 'win32')(
    'creates deterministic Brotli archives and verifies their exact entries',
    async () => {
      const value = await fixture()
      const secondOutput = join(value.outputDirectory, 'second')
      await mkdir(secondOutput)

      const first = await runtimeArchive.createSshRelayRuntimeArchive({
        ...value,
        sourceDateEpoch: 1_788_739_200
      })
      const second = await runtimeArchive.createSshRelayRuntimeArchive({
        runtimeRoot: value.runtimeRoot,
        outputDirectory: secondOutput,
        identity: value.identity,
        sourceDateEpoch: 1_788_739_200
      })

      expect(first.name).toMatch(/\.tar\.br$/u)
      expect(await readFile(first.path)).toEqual(await readFile(second.path))
      await expect(
        runtimeArchive.inspectSshRelayRuntimeArchive(first.path, value.identity)
      ).resolves.toEqual({ entries: 2, files: 1, expandedBytes: value.identity.expandedSize })
    }
  )

  it('declares the bounded architecture-independent compression contract', () => {
    expect(runtimeArchive.SSH_RELAY_RUNTIME_POSIX_ARCHIVE_LIMITS).toEqual({
      chunkBytes: 64 * 1024,
      quality: 9,
      windowBits: 20
    })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects truncated Brotli and preserves outputs it did not create',
    async () => {
      const truncated = await fixture()
      const archive = await runtimeArchive.createSshRelayRuntimeArchive({
        ...truncated,
        sourceDateEpoch: 1_788_739_200
      })
      const bytes = await readFile(archive.path)
      await writeFile(archive.path, bytes.subarray(0, -1))
      await expect(
        runtimeArchive.inspectSshRelayRuntimeArchive(archive.path, truncated.identity)
      ).rejects.toThrow()

      const existing = await fixture()
      const existingPath = join(existing.outputDirectory, archiveName(existing.identity))
      await writeFile(existingPath, 'owned by another build')
      await expect(
        runtimeArchive.createSshRelayRuntimeArchive({
          ...existing,
          sourceDateEpoch: 1_788_739_200
        })
      ).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(readFile(existingPath, 'utf8')).resolves.toBe('owned by another build')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'settles pre-cancellation without retaining a partial archive',
    async () => {
      const value = await fixture()
      await expect(
        runtimeArchive.createSshRelayRuntimeArchive({
          ...value,
          sourceDateEpoch: 1_788_739_200,
          signal: AbortSignal.abort()
        })
      ).rejects.toThrow(/abort/i)
      await expect(
        readFile(join(value.outputDirectory, archiveName(value.identity)))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('does not depend on a client-native or system XZ executable', async () => {
    const source = await readFile(
      new URL('./ssh-relay-runtime-archive.mjs', import.meta.url),
      'utf8'
    )

    expect(source).not.toContain("from 'node:child_process'")
    expect(source).not.toContain("spawn('xz'")
    expect(source).toContain('createBrotliCompress')
    expect(source).toContain('createBrotliDecompress')
  })
})
