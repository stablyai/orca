import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppImageExtractedRoot } from './appimage-extracted-root'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import { prepareAppImageCopyForServe, probeAppImageCache } from './appimage-serve-preparation'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-serve-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return { root, appImagePath, cacheRootPath: join(root, 'cache') }
}

async function writePayload(cwd: string): Promise<void> {
  const launcherDir = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'orca-ide'), '', { mode: 0o755 })
}

const acceptCache = async (): Promise<string | null> => null

describe('prepareAppImageCopyForServe', () => {
  it('returns at once, silently, when the copy already exists', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const root = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    await mkdir(join(root.rootPath, 'resources', 'bin'), { recursive: true })
    await writeFile(join(root.rootPath, 'resources', 'bin', 'orca-ide'), '', { mode: 0o755 })
    const lines: string[] = []

    const result = await prepareAppImageCopyForServe({
      appImagePath,
      cacheRootPath,
      log: (line) => lines.push(line),
      runExtract: async () => {
        throw new Error('must not extract')
      }
    })

    expect(result.status).toBe('ready')
    expect(lines).toEqual([])
  })

  it('reports progress while unpacking and when it is done', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const lines: string[] = []

    const result = await prepareAppImageCopyForServe({
      appImagePath,
      cacheRootPath,
      probeCache: acceptCache,
      progressIntervalMs: 5,
      log: (line) => lines.push(line),
      runExtract: async (_path, cwd) => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        await writePayload(cwd)
      }
    })

    expect(result.status).toBe('ready')
    expect(lines[0]).toContain('unpacking a stable copy')
    expect(lines.some((line) => line.includes('Still unpacking'))).toBe(true)
    expect(lines.at(-1)).toContain('AppImage copy ready')
  })

  it('bounds every extraction attempt by one overall deadline', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const timeouts: number[] = []
    const startedAt = Date.now()

    const result = await prepareAppImageCopyForServe({
      appImagePath,
      cacheRootPath,
      budgetMs: 200,
      probeCache: acceptCache,
      log: () => {},
      runExtract: async (_path, _cwd, timeoutMs) => {
        timeouts.push(timeoutMs)
        await new Promise((resolve) => setTimeout(resolve, timeoutMs + 5))
        throw new Error('AppImage extraction timed out.')
      }
    })

    expect(result).toMatchObject({ status: 'unavailable' })
    expect(timeouts.length).toBeGreaterThanOrEqual(1)
    expect(timeouts.every((timeout) => timeout <= 200)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('refuses before extracting when the cache cannot hold a runnable copy', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    let extracted = false

    const result = await prepareAppImageCopyForServe({
      appImagePath,
      cacheRootPath,
      probeCache: async () => 'cache is mounted noexec',
      log: () => {},
      runExtract: async () => {
        extracted = true
      }
    })

    expect(result).toMatchObject({ status: 'unavailable', reason: 'cache is mounted noexec' })
    expect(extracted).toBe(false)
  })

  it('gives up waiting for the lock at the deadline', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    let release!: () => void
    const held = withAppImageRegistrationLock(
      cacheRootPath,
      () => new Promise<void>((resolve) => (release = resolve))
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const result = await prepareAppImageCopyForServe({
      appImagePath,
      cacheRootPath,
      budgetMs: 300,
      probeCache: acceptCache,
      log: () => {},
      runExtract: async (_path, cwd) => writePayload(cwd)
    })
    release()
    await held

    expect(result).toMatchObject({ status: 'unavailable' })
  })
})

// POSIX permissions and shebang execution are what the probe measures.
describe.skipIf(process.platform === 'win32')('probeAppImageCache', () => {
  it('accepts a private, writable cache that can run programs', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toBeNull()
  })

  it('accepts an AppImage in a read-only directory', async () => {
    const { root, cacheRootPath } = await makeFixture()
    const readOnlyDir = join(root, 'opt')
    await mkdir(readOnlyDir)
    const appImagePath = join(readOnlyDir, 'Orca.AppImage')
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    await chmod(readOnlyDir, 0o555)
    try {
      await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toBeNull()
    } finally {
      await chmod(readOnlyDir, 0o755)
    }
  })

  it('refuses a cache other users can write to', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await mkdir(cacheRootPath, { recursive: true })
    await chmod(cacheRootPath, 0o777)
    await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toContain(
      'writable by other users'
    )
  })

  it.skipIf(process.getuid?.() === 0)('refuses a cache it cannot write to', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    await mkdir(cacheRootPath, { recursive: true })
    await chmod(cacheRootPath, 0o500)
    try {
      await expect(probeAppImageCache(cacheRootPath, appImagePath)).resolves.toContain(
        'not writable'
      )
    } finally {
      await chmod(cacheRootPath, 0o700)
    }
  })
})
