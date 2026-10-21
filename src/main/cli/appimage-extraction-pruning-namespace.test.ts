import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Residency from './appimage-generation-residency'

const residentExecutables = vi.hoisted(() => {
  const state: { paths: string[] } = { paths: [] }
  return state
})

vi.mock('./appimage-generation-residency', async (importOriginal) => {
  const actual = await importOriginal<typeof Residency>()
  return {
    ...actual,
    scanResidentExecutables: () => ({
      status: 'scanned',
      executables: residentExecutables.paths,
      unreadablePid: null
    })
  }
})

import {
  isAppImageInstalledLauncherOwnedBySibling,
  resolveAppImageExtractedRoot,
  resolveAppImageNamespacePath,
  resolveLegacyAppImageNamespacePath
} from './appimage-extracted-root'
import { pruneAppImageExtractedRoots } from './appimage-extraction-pruning'
import { leaseAppImageGenerationForCurrentProcess } from './appimage-generation-lease'
import { publishAppImageLauncherEndpoint } from './appimage-stable-launcher'

const created: string[] = []

afterEach(async () => {
  residentExecutables.paths = []
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-namespace-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  const options = { appImagePath, cacheRootPath: join(root, 'cache') }
  return { options, keep: resolveAppImageExtractedRoot(options)! }
}

async function writePayload(rootPath: string): Promise<string> {
  const launcherPath = join(rootPath, 'resources', 'bin', 'orca-ide')
  await mkdir(dirname(launcherPath), { recursive: true })
  await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return launcherPath
}

describe('AppImage generation namespace', () => {
  it('extracts outside the namespace that pre-lease pruners scan', async () => {
    const { options, keep } = await makeFixture()
    const legacyNamespace = resolveLegacyAppImageNamespacePath(options)

    expect(dirname(keep.rootPath)).toBe(resolveAppImageNamespacePath(options))
    expect(resolveAppImageNamespacePath(options)).not.toBe(legacyNamespace)
    expect(dirname(dirname(keep.rootPath))).toBe(dirname(legacyNamespace))
  })

  it('a pre-lease pruner keeping its own generation never reaches the new namespace', async () => {
    const { options, keep } = await makeFixture()
    const legacyKeep = join(resolveLegacyAppImageNamespacePath(options), 'c'.repeat(24))
    await Promise.all([writePayload(keep.rootPath), writePayload(legacyKeep)])

    // Pre-lease builds prune only the parent of the generation they keep.
    await pruneAppImageExtractedRoots(legacyKeep)

    expect(existsSync(keep.rootPath)).toBe(true)
  })

  it('treats the legacy namespace of the same AppImage as its own, not a sibling', async () => {
    const { options } = await makeFixture()
    const legacyLauncher = await writePayload(
      join(resolveLegacyAppImageNamespacePath(options), 'c'.repeat(24))
    )
    publishAppImageLauncherEndpoint(options.cacheRootPath, 'installed', legacyLauncher)

    expect(isAppImageInstalledLauncherOwnedBySibling(options)).toBe(false)
  })

  it('reclaims idle legacy generations but keeps resident and installed ones', async () => {
    const { options, keep } = await makeFixture()
    const legacyNamespace = resolveLegacyAppImageNamespacePath(options)
    const [idle, resident, installed] = ['c', 'd', 'e'].map((key) =>
      join(legacyNamespace, key.repeat(24))
    )
    const installedLauncher = await writePayload(installed!)
    await Promise.all([writePayload(keep.rootPath), writePayload(idle!), writePayload(resident!)])
    publishAppImageLauncherEndpoint(options.cacheRootPath, 'installed', installedLauncher)
    residentExecutables.paths = [join(resident!, 'orca-ide')]

    await pruneAppImageExtractedRoots(keep.rootPath, legacyNamespace)

    expect(existsSync(idle!)).toBe(false)
    expect(existsSync(resident!)).toBe(true)
    expect(existsSync(installed!)).toBe(true)
    expect(existsSync(keep.rootPath)).toBe(true)
  })

  it('keeps a generation whose process is resident', async () => {
    const { keep } = await makeFixture()
    const older = join(dirname(keep.rootPath), 'c'.repeat(24))
    await Promise.all([writePayload(keep.rootPath), writePayload(older)])
    residentExecutables.paths = [`${join(older, 'orca-ide')} (deleted)`]

    await pruneAppImageExtractedRoots(keep.rootPath)

    expect(existsSync(older)).toBe(true)
  })

  it.runIf(process.platform === 'linux')(
    'keeps a generation leased by a live process and reclaims it once the lease is stale',
    async () => {
      const { keep } = await makeFixture()
      const older = join(dirname(keep.rootPath), 'c'.repeat(24))
      await Promise.all([writePayload(keep.rootPath), writePayload(older)])
      const leasePath = await leaseAppImageGenerationForCurrentProcess({
        execPath: join(older, 'orca-ide')
      })
      expect(leasePath).not.toBeNull()

      await pruneAppImageExtractedRoots(keep.rootPath)
      expect(existsSync(older)).toBe(true)

      // The same pid with another start time is a recycled pid, not the holder.
      const recycled = join(
        dirname(leasePath!),
        basename(leasePath!).replace(/\.\d+\.json$/u, '.1.json')
      )
      await rm(leasePath!)
      await writeFile(
        recycled,
        JSON.stringify({ pid: process.pid, linuxStartTicks: '1', bootId: 'x' })
      )
      await pruneAppImageExtractedRoots(keep.rootPath)
      expect(existsSync(older)).toBe(false)
      expect(existsSync(recycled)).toBe(false)
    }
  )
})
