import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureAppImageExtractedRoot,
  isAppImageInstalledLauncherOwnedBySibling,
  readAppImageSourceOfNamespace,
  resolveAppImageCacheKey,
  resolveAppImageExtractedRoot
} from './appimage-extracted-root'
import { getAppImageActiveExtractionPath } from './appimage-extraction-pruning'
import {
  publishAppImageLauncherEndpoint,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture(): Promise<{
  root: string
  appImagePath: string
  cacheRootPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-extract-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
  return { root, appImagePath, cacheRootPath: join(root, 'cache') }
}

/** Stands in for the AppImage runtime, which writes ./squashfs-root under cwd. */
async function writePayload(cwd: string, content = ''): Promise<void> {
  const launcherDir = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'orca-ide'), content, { encoding: 'utf8', mode: 0o755 })
}

describe('appimage extracted root', () => {
  // Why: a server running from the copy has no $APPIMAGE; this record is how it finds the file.
  it('records which AppImage a namespace came from, and rejects a record for another path', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const root = await ensureAppImageExtractedRoot({
      appImagePath,
      cacheRootPath,
      runExtract: async (_path, cwd) => writePayload(cwd)
    })
    const namespacePath = dirname(root!.rootPath)
    const namespaceKey = namespacePath.slice(namespacePath.lastIndexOf('/') + 1)

    expect(readAppImageSourceOfNamespace(cacheRootPath, namespaceKey)).toBe(appImagePath)
    await writeFile(join(namespacePath, 'source-appimage'), '/elsewhere/Orca.AppImage')
    expect(readAppImageSourceOfNamespace(cacheRootPath, namespaceKey)).toBeNull()
  })

  // chmod, backup restores and SELinux relabels must not trigger re-extraction of unchanged payloads.
  it('does not re-key the payload when only inode metadata changes', async () => {
    const { appImagePath } = await makeFixture()
    const before = resolveAppImageCacheKey(appImagePath)

    await chmod(appImagePath, 0o700)
    expect(resolveAppImageCacheKey(appImagePath)).toBe(before)

    await chmod(appImagePath, 0o755)
    expect(resolveAppImageCacheKey(appImagePath)).toBe(before)
  })

  it('publishes nothing when extraction fails partway', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()

    const result = await ensureAppImageExtractedRoot({
      appImagePath,
      cacheRootPath,
      runExtract: async (_path, cwd) => {
        await mkdir(join(cwd, 'squashfs-root'), { recursive: true })
        throw new Error('extraction interrupted')
      }
    })

    expect(result).toBeNull()
    await expect(readdir(cacheRootPath)).resolves.toEqual([])
  })

  it('retains one retry payload when a foreign stable launcher blocks publication', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const root = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const launcherPath = resolveAppImageStableLauncherPath(cacheRootPath)
    let extractionCount = 0
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\nprintf foreign\n', { mode: 0o755 })

    const extract = async (_path: string, cwd: string): Promise<void> => {
      extractionCount += 1
      await writePayload(cwd)
    }
    const options = { appImagePath, cacheRootPath, runExtract: extract }

    await expect(ensureAppImageExtractedRoot(options)).resolves.toBeNull()
    await expect(ensureAppImageExtractedRoot(options)).resolves.toBeNull()
    expect(extractionCount).toBe(1)
    expect(existsSync(root.rootPath)).toBe(true)
    expect(existsSync(getAppImageActiveExtractionPath(root.rootPath))).toBe(false)
    await expect(readFile(launcherPath, 'utf8')).resolves.toContain('foreign')
  })

  it.each(['directory', 'non-executable'] as const)(
    'rejects a %s launcher entry',
    async (entryKind) => {
      const { appImagePath, cacheRootPath } = await makeFixture()

      const result = await ensureAppImageExtractedRoot({
        appImagePath,
        cacheRootPath,
        runExtract: async (_path, cwd) => {
          const launcherPath = join(cwd, 'squashfs-root', 'resources', 'bin', 'orca-ide')
          if (entryKind === 'directory') {
            await mkdir(launcherPath, { recursive: true })
          } else {
            await mkdir(dirname(launcherPath), { recursive: true })
            await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o644 })
          }
        }
      })

      expect(result).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a launcher symlink even when its target is executable',
    async () => {
      const { root, appImagePath, cacheRootPath } = await makeFixture()
      const executable = join(root, 'foreign-launcher')
      await writeFile(executable, '#!/usr/bin/env bash\n', { mode: 0o755 })

      const result = await ensureAppImageExtractedRoot({
        appImagePath,
        cacheRootPath,
        runExtract: async (_path, cwd) => {
          const launcherPath = join(cwd, 'squashfs-root', 'resources', 'bin', 'orca-ide')
          await mkdir(dirname(launcherPath), { recursive: true })
          await symlink(executable, launcherPath)
        }
      })

      expect(result).toBeNull()
    }
  )

  it('preserves the winner when concurrent calls repair an incomplete root', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const root = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    await mkdir(root.rootPath, { recursive: true })
    await writeFile(join(root.rootPath, 'partial'), 'interrupted')
    let readyCount = 0
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const runExtract = async (_path: string, cwd: string): Promise<void> => {
      readyCount += 1
      await writePayload(cwd, `winner-${readyCount}`)
      if (readyCount === 2) {
        release()
      }
      await bothReady
    }

    const results = await Promise.all([
      ensureAppImageExtractedRoot({ appImagePath, cacheRootPath, runExtract }),
      ensureAppImageExtractedRoot({ appImagePath, cacheRootPath, runExtract })
    ])

    expect(results).toEqual([root, root])
    expect(['winner-1', 'winner-2']).toContain(await readFile(root.payloadLauncherPath, 'utf8'))
  })

  it('retries with the current generation when the AppImage changes during extraction', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const initialRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    let extractCount = 0

    const result = await ensureAppImageExtractedRoot({
      appImagePath,
      cacheRootPath,
      runExtract: async (_path, cwd) => {
        extractCount += 1
        await writePayload(cwd, `generation-${extractCount}`)
        if (extractCount === 1) {
          await writeFile(appImagePath, '#!/usr/bin/env bash\n# replaced during extraction\n', {
            encoding: 'utf8',
            mode: 0o755
          })
        }
      }
    })

    const currentRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    expect(extractCount).toBe(2)
    expect(result).toEqual(currentRoot)
    expect(result?.rootPath).not.toBe(initialRoot.rootPath)
    await expect(readFile(currentRoot.payloadLauncherPath, 'utf8')).resolves.toBe('generation-2')
    expect(existsSync(initialRoot.rootPath)).toBe(false)
  })

  it('bounds retries when every extraction changes the AppImage generation', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    let extractCount = 0

    const result = await ensureAppImageExtractedRoot({
      appImagePath,
      cacheRootPath,
      runExtract: async (_path, cwd) => {
        extractCount += 1
        await writePayload(cwd)
        await writeFile(appImagePath, '#'.repeat(extractCount + 1), { mode: 0o755 })
      }
    })

    expect(result).toBeNull()
    expect(extractCount).toBe(2)
  })

  it('requires a sibling installed endpoint to target an executable payload', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const siblingLauncher = join(
      cacheRootPath,
      'a'.repeat(24),
      'b'.repeat(24),
      'resources',
      'bin',
      'orca-ide'
    )
    publishAppImageLauncherEndpoint(cacheRootPath, 'installed', siblingLauncher)
    const options = { appImagePath, cacheRootPath }

    expect(isAppImageInstalledLauncherOwnedBySibling(options)).toBe(false)

    await mkdir(dirname(siblingLauncher), { recursive: true })
    await writeFile(siblingLauncher, '#!/usr/bin/env bash\n', { mode: 0o755 })
    expect(isAppImageInstalledLauncherOwnedBySibling(options)).toBe(true)
  })
})
