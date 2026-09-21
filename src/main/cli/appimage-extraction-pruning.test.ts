import { existsSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readlink, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const publicationRace = vi.hoisted(() => ({ endpointPath: '', replacementTarget: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (source === publicationRace.endpointPath && publicationRace.replacementTarget) {
        await actual.unlink(source)
        await actual.symlink(publicationRace.replacementTarget, source)
        publicationRace.replacementTarget = ''
      }
      return actual.rename(source, destination)
    }
  }
})

import {
  ensureAppImageExtractedRoot,
  resolveAppImageExtractedRoot
} from './appimage-extracted-root'
import {
  getAppImageActiveExtractionPath,
  pruneAppImageExtractedRoots,
  removeAppImageInstalledPayloads
} from './appimage-extraction-pruning'
import {
  publishAppImageLauncherEndpoint,
  resolveAppImageLauncherEndpointPath
} from './appimage-stable-launcher'

const created: string[] = []

afterEach(async () => {
  publicationRace.endpointPath = ''
  publicationRace.replacementTarget = ''
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function writePayload(rootPath: string, content = '#!/usr/bin/env bash\n'): Promise<string> {
  const launcherPath = join(rootPath, 'resources', 'bin', 'orca-ide')
  await mkdir(dirname(launcherPath), { recursive: true })
  await writeFile(launcherPath, content, { mode: 0o755 })
  return launcherPath
}

async function makeExtractionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-pruning-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return { root, appImagePath, cacheRootPath: join(root, 'cache') }
}

function cacheKeyApartFrom(...excluded: string[]): string {
  return (
    ['a', 'b', 'c'].map((value) => value.repeat(24)).find((key) => !excluded.includes(key)) ??
    'd'.repeat(24)
  )
}

describe('AppImage extraction pruning', () => {
  it('prunes stale generations without touching sibling namespaces', async () => {
    const { appImagePath, cacheRootPath } = await makeExtractionFixture()
    const keepRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const keepKey = basename(keepRoot.rootPath)
    const staleRoot = join(dirname(keepRoot.rootPath), cacheKeyApartFrom(keepKey))
    const siblingRoot = join(
      cacheRootPath,
      cacheKeyApartFrom(basename(dirname(keepRoot.rootPath))),
      'd'.repeat(24)
    )
    await Promise.all([
      mkdir(keepRoot.rootPath, { recursive: true }),
      mkdir(staleRoot, { recursive: true }),
      mkdir(siblingRoot, { recursive: true })
    ])

    await pruneAppImageExtractedRoots(keepRoot.rootPath)

    expect(existsSync(keepRoot.rootPath)).toBe(true)
    expect(existsSync(staleRoot)).toBe(false)
    expect(existsSync(siblingRoot)).toBe(true)
  })

  it('a sibling installed endpoint does not displace the owner generation', async () => {
    const { appImagePath, cacheRootPath } = await makeExtractionFixture()
    const ownerRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const siblingRoot = join(
      dirname(ownerRoot.rootPath),
      cacheKeyApartFrom(basename(ownerRoot.rootPath))
    )
    const [ownerLauncher, siblingLauncher] = await Promise.all([
      writePayload(ownerRoot.rootPath, 'owner'),
      writePayload(siblingRoot, 'installed')
    ])
    publishAppImageLauncherEndpoint(cacheRootPath, 'installed', siblingLauncher)

    await pruneAppImageExtractedRoots(ownerRoot.rootPath)

    await expect(readFile(ownerLauncher, 'utf8')).resolves.toBe('owner')
    await expect(readFile(siblingLauncher, 'utf8')).resolves.toBe('installed')
    await expect(
      readlink(resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed'))
    ).resolves.toBe(siblingLauncher)
  })

  it('preserves an active extraction during pruning', async () => {
    const { appImagePath, cacheRootPath } = await makeExtractionFixture()
    const root = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    let reportStarted!: (stagingPath: string) => void
    let releaseExtraction!: () => void
    const started = new Promise<string>((resolve) => {
      reportStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseExtraction = resolve
    })
    const extraction = ensureAppImageExtractedRoot({
      appImagePath,
      cacheRootPath,
      runExtract: async (_path, cwd) => {
        reportStarted(cwd)
        await release
        await writePayload(join(cwd, 'squashfs-root'), '')
      }
    })
    const stagingPath = await started

    try {
      await pruneAppImageExtractedRoots(root.rootPath)
      expect(existsSync(stagingPath)).toBe(true)
    } finally {
      releaseExtraction()
    }
    await expect(extraction).resolves.toEqual(root)
  })

  it('retains recent cross-process staging and reclaims stale staging', async () => {
    const { appImagePath, cacheRootPath } = await makeExtractionFixture()
    const root = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const namespacePath = dirname(root.rootPath)
    const recentStaging = join(namespacePath, '.extract-recent')
    const staleStaging = join(namespacePath, '.extract-stale')
    await Promise.all([
      mkdir(root.rootPath, { recursive: true }),
      mkdir(recentStaging, { recursive: true }),
      mkdir(staleStaging, { recursive: true })
    ])
    await utimes(staleStaging, 0, 0)

    await pruneAppImageExtractedRoots(root.rootPath)

    expect(existsSync(recentStaging)).toBe(true)
    expect(existsSync(staleStaging)).toBe(false)
  })

  it('preserves a recent active generation marker and reclaims a stale marker', async () => {
    const { appImagePath, cacheRootPath } = await makeExtractionFixture()
    const keepRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
    const keepKey = basename(keepRoot.rootPath)
    const recentRoot = join(dirname(keepRoot.rootPath), cacheKeyApartFrom(keepKey))
    const staleRoot = join(
      dirname(keepRoot.rootPath),
      cacheKeyApartFrom(keepKey, basename(recentRoot))
    )
    const recentMarker = getAppImageActiveExtractionPath(recentRoot)
    const staleMarker = getAppImageActiveExtractionPath(staleRoot)
    await Promise.all([
      mkdir(keepRoot.rootPath, { recursive: true }),
      mkdir(recentRoot, { recursive: true }),
      mkdir(staleRoot, { recursive: true })
    ])
    await Promise.all([writeFile(recentMarker, ''), writeFile(staleMarker, '')])
    await utimes(staleMarker, 0, 0)

    await pruneAppImageExtractedRoots(keepRoot.rootPath)

    expect(existsSync(recentRoot)).toBe(true)
    expect(existsSync(recentMarker)).toBe(true)
    expect(existsSync(staleRoot)).toBe(false)
    expect(existsSync(staleMarker)).toBe(false)
  })

  it('tolerates a missing cache namespace', async () => {
    const { root } = await makeExtractionFixture()

    await expect(
      pruneAppImageExtractedRoots(join(root, 'never-made', 'a'.repeat(24), 'b'.repeat(24)))
    ).resolves.toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'restores a sibling endpoint that wins the uninstall rename race',
    async () => {
      const cacheRootPath = await mkdtemp(join(tmpdir(), 'orca-appimage-pruning-'))
      created.push(cacheRootPath)
      const ownerNamespace = join(cacheRootPath, 'a'.repeat(24))
      const siblingNamespace = join(cacheRootPath, 'b'.repeat(24))
      const ownerLauncher = await writePayload(join(ownerNamespace, 'c'.repeat(24)))
      const siblingLauncher = await writePayload(join(siblingNamespace, 'd'.repeat(24)))
      const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
      publishAppImageLauncherEndpoint(cacheRootPath, 'installed', ownerLauncher)
      publicationRace.endpointPath = endpointPath
      publicationRace.replacementTarget = siblingLauncher

      await removeAppImageInstalledPayloads(ownerNamespace)

      await expect(readlink(endpointPath)).resolves.toBe(siblingLauncher)
      expect(existsSync(ownerNamespace)).toBe(false)
      expect(existsSync(siblingLauncher)).toBe(true)
    }
  )
})
