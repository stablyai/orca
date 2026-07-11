import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareWslWatcherRuntime } from './prepare-wsl-watcher-runtime.mjs'

function deferred() {
  let resolve
  const promise = new Promise((createdResolve) => {
    resolve = createdResolve
  })
  return { promise, resolve }
}

async function pathExists(filename) {
  try {
    await stat(filename)
    return true
  } catch {
    return false
  }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-wsl-runtime-recovery-'))
  const output = join(root, 'out', 'wsl-watcher')
  const hostSource = join(root, 'out', 'main', 'wsl-watcher-host.js')
  const archive = join(root, 'node.tar.xz')
  await mkdir(join(root, 'out', 'main'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@parcel', 'watcher'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@parcel', 'watcher-linux-x64-glibc'), {
    recursive: true
  })
  await writeFile(hostSource, 'host version one')
  await writeFile(join(root, 'node_modules', '@parcel', 'watcher', 'LICENSE'), 'license')
  await writeFile(
    join(root, 'node_modules', '@parcel', 'watcher-linux-x64-glibc', 'watcher.node'),
    'native payload'
  )
  const archivePayload = 'archive payload'
  await writeFile(archive, archivePayload)
  return {
    root,
    output,
    hostSource,
    archive,
    archiveHash: createHash('sha256').update(archivePayload).digest('hex')
  }
}

function options(fixture, publicationId, overrides = {}) {
  return {
    runtimeRootDir: fixture.root,
    runtimeOutputDir: fixture.output,
    fetchRuntimeArchive: vi.fn(async () => fixture.archive),
    archives: {
      x64: {
        sha256: fixture.archiveHash,
        watcherPackage: '@parcel/watcher-linux-x64-glibc'
      }
    },
    createPublicationId: () => publicationId,
    publicationLockOptions: { retryDelayMs: 1, timeoutMs: 2_000 },
    ...overrides
  }
}

describe('WSL runtime crash recovery and immutable package source', () => {
  it('keeps the atomic development pointer readable while public publication is paused', async () => {
    const fixture = await makeFixture()
    const secondReady = deferred()
    const releaseSecond = deferred()
    try {
      const first = await prepareWslWatcherRuntime(options(fixture, 'first'))
      await writeFile(fixture.hostSource, 'host version two')
      const secondPending = prepareWslWatcherRuntime(
        options(fixture, 'second', {
          runtimeFileOperations: {
            rename: async (from, to) => {
              await rename(from, to)
              if (from === fixture.output && to === `${fixture.output}.backup-second`) {
                secondReady.resolve()
                await releaseSecond.promise
              }
            }
          }
        })
      )
      await secondReady.promise

      expect(await pathExists(fixture.output)).toBe(false)
      const pointerPath = `${fixture.output}.current.json`
      const firstPointer = JSON.parse(await readFile(pointerPath, 'utf8'))
      const pointedSource = resolve(dirname(pointerPath), ...firstPointer.relativePath.split('/'))
      expect(pointedSource).toBe(first.packageSourceDir)
      await expect(readFile(join(first.packageSourceDir, 'host.js'), 'utf8')).resolves.toBe(
        'host version one'
      )
      releaseSecond.resolve()
      const second = await secondPending
      expect(second.packageSourceDir).not.toBe(first.packageSourceDir)
      await expect(readFile(join(second.packageSourceDir, 'host.js'), 'utf8')).resolves.toBe(
        'host version two'
      )
      const secondPointer = JSON.parse(await readFile(pointerPath, 'utf8'))
      expect(secondPointer.bundleVersion).toBe(second.bundleVersion)
    } finally {
      releaseSecond.resolve()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rehashes and repairs a corrupted immutable build instead of reusing it', async () => {
    const fixture = await makeFixture()
    try {
      const first = await prepareWslWatcherRuntime(options(fixture, 'first-corruption'))
      await writeFile(join(first.packageSourceDir, 'host.js'), 'corrupted host')

      const repaired = await prepareWslWatcherRuntime(options(fixture, 'repair-corruption'))

      expect(repaired.packageSourceDir).toBe(first.packageSourceDir)
      await expect(readFile(join(repaired.packageSourceDir, 'host.js'), 'utf8')).resolves.toBe(
        'host version one'
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('recovers a valid crash backup and scavenges an aged abandoned stage', async () => {
    const fixture = await makeFixture()
    try {
      await prepareWslWatcherRuntime(options(fixture, 'initial'))
      const backup = `${fixture.output}.backup-crash`
      const abandoned = `${fixture.output}.stage-abandoned`
      await rename(fixture.output, backup)
      await mkdir(abandoned)
      await writeFile(join(abandoned, 'partial'), 'partial')
      await utimes(abandoned, new Date(0), new Date(0))
      await writeFile(fixture.hostSource, 'host version two')

      await expect(
        prepareWslWatcherRuntime(
          options(fixture, 'recovery', {
            beforePublish: async () => {
              expect(await readFile(join(fixture.output, 'host.js'), 'utf8')).toBe(
                'host version one'
              )
              throw new Error('stop after recovery')
            }
          })
        )
      ).rejects.toThrow('stop after recovery')

      await expect(readFile(join(fixture.output, 'host.js'), 'utf8')).resolves.toBe(
        'host version one'
      )
      await expect(pathExists(abandoned)).resolves.toBe(false)
      await expect(pathExists(backup)).resolves.toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
