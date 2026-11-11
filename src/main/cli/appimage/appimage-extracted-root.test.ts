import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureAppImageExtractedRoot } from './appimage-extracted-root'
import { readAppImageSourceOfNamespace } from '../../../shared/appimage-cache-identity'

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
})
