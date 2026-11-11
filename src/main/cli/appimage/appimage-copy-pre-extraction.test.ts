import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAppImageExtractedRoot } from './appimage-extracted-root'
import { resolveAppImageLauncherEndpointPath } from './appimage-stable-launcher'
import type * as PreExtractionModule from './appimage-copy-pre-extraction'

type PreExtraction = typeof PreExtractionModule

const created: string[] = []
let preExtraction: PreExtraction

beforeEach(async () => {
  // Why: the module holds this launch's in-flight copy, so every test starts a fresh launch.
  vi.resetModules()
  preExtraction = await import('./appimage-copy-pre-extraction')
})

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-pre-extract-'))
  created.push(root)
  const appImagePath = join(root, 'apps', 'Orca.AppImage')
  await mkdir(join(root, 'apps'), { recursive: true })
  await writeFile(appImagePath, 'release 1.0.0', { mode: 0o755 })
  return { root, appImagePath, cacheRootPath: join(root, 'cache') }
}

async function writePayload(cwd: string): Promise<void> {
  const launcherDir = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'orca-ide'), '', { mode: 0o755 })
}

const acceptCache = async (): Promise<string | null> => null

describe('preExtractDownloadedAppImageUpdate', () => {
  it('unpacks the download into the copy its install will run from', async () => {
    const { root, appImagePath, cacheRootPath } = await makeFixture()
    const downloadedFile = join(root, 'apps', '.pending-Orca.AppImage')
    await writeFile(downloadedFile, 'release 2.0.0', { mode: 0o755 })

    const staged = await preExtraction.preExtractDownloadedAppImageUpdate(
      downloadedFile,
      async () => true,
      {
        appImagePath,
        cacheRootPath,
        probeCache: acceptCache,
        runExtract: async (path, cwd) => {
          expect(path).toBe(downloadedFile)
          await writePayload(cwd)
        },
        log: () => {}
      }
    )
    expect(staged).toBe(true)

    // What the updater's install does on one filesystem: a rename, which keeps the file identity.
    await rename(downloadedFile, appImagePath)
    const installed = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    expect(existsSync(installed.payloadLauncherPath)).toBe(true)
    expect(existsSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed'))).toBe(false)
  })

  it('never runs a file that is not the updater download', async () => {
    const { root, appImagePath, cacheRootPath } = await makeFixture()
    const planted = join(root, 'Orca-2.0.0.AppImage')
    await writeFile(planted, 'not an update', { mode: 0o755 })
    const runExtract = vi.fn()

    expect(
      await preExtraction.preExtractDownloadedAppImageUpdate(planted, async () => false, {
        appImagePath,
        cacheRootPath,
        probeCache: acceptCache,
        runExtract
      })
    ).toBe(false)
    expect(
      await preExtraction.preExtractDownloadedAppImageUpdate(
        'relative.AppImage',
        async () => true,
        {
          appImagePath,
          cacheRootPath,
          runExtract
        }
      )
    ).toBe(false)
    expect(runExtract).not.toHaveBeenCalled()
  })
})
