import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const root = await mkdtemp(join(tmpdir(), 'orca-wsl-runtime-stage-'))
  const output = join(root, 'out', 'wsl-watcher')
  const archive = join(root, 'node.tar.xz')
  await mkdir(join(root, 'out', 'main'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@parcel', 'watcher'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@parcel', 'watcher-linux-x64-glibc'), {
    recursive: true
  })
  await writeFile(join(root, 'out', 'main', 'wsl-watcher-host.js'), 'host payload', 'utf8')
  await writeFile(join(root, 'node_modules', '@parcel', 'watcher', 'LICENSE'), 'license', 'utf8')
  await writeFile(
    join(root, 'node_modules', '@parcel', 'watcher-linux-x64-glibc', 'watcher.node'),
    'native payload',
    'utf8'
  )
  const archivePayload = 'archive payload'
  await writeFile(archive, archivePayload, 'utf8')
  return {
    root,
    output,
    archive,
    archiveHash: createHash('sha256').update(archivePayload).digest('hex')
  }
}

function preparationOptions(fixture, overrides = {}) {
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
    publicationLockOptions: { retryDelayMs: 1, timeoutMs: 2_000 },
    ...overrides
  }
}

describe('prepareWslWatcherRuntime', () => {
  it('removes failed unique staging without replacing the last complete runtime', async () => {
    const fixture = await makeFixture()
    try {
      await mkdir(fixture.output, { recursive: true })
      await writeFile(join(fixture.output, 'complete.txt'), 'last complete runtime', 'utf8')
      const options = preparationOptions(fixture, {
        createPublicationId: () => 'failed',
        fetchRuntimeArchive: vi.fn().mockRejectedValue(new Error('download interrupted'))
      })

      await expect(prepareWslWatcherRuntime(options)).rejects.toThrow('download interrupted')

      await expect(pathExists(`${fixture.output}.stage-failed`)).resolves.toBe(false)
      await expect(readFile(join(fixture.output, 'complete.txt'), 'utf8')).resolves.toBe(
        'last complete runtime'
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent publication after both unique stages are complete', async () => {
    const fixture = await makeFixture()
    const firstLocked = deferred()
    const releaseFirst = deferred()
    const secondBlocked = deferred()
    let secondAcquired = false
    try {
      const first = prepareWslWatcherRuntime(
        preparationOptions(fixture, {
          createPublicationId: () => 'first',
          afterPublicationLockAcquired: async () => {
            firstLocked.resolve()
            await releaseFirst.promise
          }
        })
      )
      await firstLocked.promise

      const second = prepareWslWatcherRuntime(
        preparationOptions(fixture, {
          createPublicationId: () => 'second',
          runtimeFileOperations: {
            mkdir: async (filename, options) => {
              try {
                return await mkdir(filename, options)
              } catch (error) {
                if (filename === `${fixture.output}.publish.lock` && error?.code === 'EEXIST') {
                  secondBlocked.resolve()
                }
                throw error
              }
            }
          },
          afterPublicationLockAcquired: () => {
            secondAcquired = true
          }
        })
      )
      await secondBlocked.promise
      expect(secondAcquired).toBe(false)
      releaseFirst.resolve()
      await Promise.all([first, second])

      expect(secondAcquired).toBe(true)
      await expect(readFile(join(fixture.output, 'host.js'), 'utf8')).resolves.toBe('host payload')
      await expect(readFile(join(fixture.output, 'manifest.json'), 'utf8')).resolves.toContain(
        '"bundleVersion"'
      )
      expect(
        (await readdir(join(fixture.root, 'out'))).filter((name) =>
          /\.(?:stage|backup)-|\.publish\.lock$/.test(name)
        )
      ).toEqual([])
    } finally {
      releaseFirst.resolve()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rolls back the previous complete output when final publication rename fails', async () => {
    const fixture = await makeFixture()
    try {
      await mkdir(fixture.output, { recursive: true })
      await writeFile(join(fixture.output, 'complete.txt'), 'known good', 'utf8')
      const stage = `${fixture.output}.stage-rollback`
      const options = preparationOptions(fixture, {
        createPublicationId: () => 'rollback',
        runtimeFileOperations: {
          rename: async (from, to) => {
            if (from === stage && to === fixture.output) {
              throw new Error('final rename failed')
            }
            return rename(from, to)
          }
        }
      })

      await expect(prepareWslWatcherRuntime(options)).rejects.toThrow('final rename failed')

      await expect(readFile(join(fixture.output, 'complete.txt'), 'utf8')).resolves.toBe(
        'known good'
      )
      expect((await readdir(join(fixture.root, 'out'))).sort()).toEqual([
        'main',
        'wsl-watcher',
        'wsl-watcher.builds'
      ])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
