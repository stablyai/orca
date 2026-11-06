import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('startAppImageCopyPreExtraction', () => {
  it('unpacks a missing copy in the background without taking the CLI launcher', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const lines: string[] = []

    const started = preExtraction.startAppImageCopyPreExtraction({
      appImagePath,
      cacheRootPath,
      probeCache: acceptCache,
      runExtract: async (_path, cwd) => writePayload(cwd),
      log: (line) => lines.push(line)
    })

    expect(await started).toBe(true)
    expect(await preExtraction.waitForAppImageCopyPreExtraction(10)).toBe(true)
    const copy = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    expect(existsSync(copy.payloadLauncherPath)).toBe(true)
    expect(existsSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed'))).toBe(false)
    expect(lines.at(-1)).toContain('Unpacked this AppImage')
  })

  it('drops idle copies of earlier releases once this one has its copy', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const copy = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const earlier = join(dirname(copy.rootPath), 'a'.repeat(24))
    await mkdir(join(earlier, 'resources', 'bin'), { recursive: true })
    await writeFile(join(earlier, 'resources', 'bin', 'orca-ide'), '', { mode: 0o755 })

    const started = preExtraction.startAppImageCopyPreExtraction({
      appImagePath,
      cacheRootPath,
      probeCache: acceptCache,
      runExtract: async (_path, cwd) => writePayload(cwd),
      log: () => {}
    })

    expect(await started).toBe(true)
    await vi.waitFor(() => expect(existsSync(earlier)).toBe(false))
    expect(existsSync(copy.payloadLauncherPath)).toBe(true)
  })

  it('drops idle earlier copies at a launch that already has its copy', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    const copy = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    await mkdir(join(copy.rootPath, 'resources', 'bin'), { recursive: true })
    await writeFile(copy.payloadLauncherPath, '', { mode: 0o755 })
    const earlier = join(dirname(copy.rootPath), 'b'.repeat(24))
    await mkdir(join(earlier, 'resources', 'bin'), { recursive: true })

    expect(preExtraction.startAppImageCopyPreExtraction({ appImagePath, cacheRootPath })).toBeNull()
    await vi.waitFor(() => expect(existsSync(earlier)).toBe(false))
    expect(existsSync(copy.payloadLauncherPath)).toBe(true)
  })

  it('stops waiting at the bound while the copy is still unpacking', async () => {
    const { appImagePath, cacheRootPath } = await makeFixture()
    let finish: () => void = () => {}
    const extracting = new Promise<void>((resolve) => {
      finish = resolve
    })

    const started = preExtraction.startAppImageCopyPreExtraction({
      appImagePath,
      cacheRootPath,
      probeCache: acceptCache,
      runExtract: async (_path, cwd) => {
        await extracting
        await writePayload(cwd)
      },
      log: () => {}
    })

    expect(await preExtraction.waitForAppImageCopyPreExtraction(20)).toBe(false)
    finish()
    expect(await started).toBe(true)
  })
})

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
