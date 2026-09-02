import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { resolveAppImageExtractedRoot, type AppImageExtractedRoot } from './appimage-extracted-root'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'

const created: string[] = []

type Fixture = Awaited<ReturnType<typeof makeFixture>>

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-appimage-ownership-'))
  created.push(root)
  const appImagePath = join(root, 'Orca.AppImage')
  const cacheRootPath = join(root, 'cache')
  const commandDirectory = join(root, 'home', '.local', 'bin')
  const commandPath = join(commandDirectory, 'orca-ide')
  await mkdir(commandDirectory, { recursive: true })
  await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return { root, appImagePath, cacheRootPath, commandDirectory, commandPath }
}

async function extractPayload(_appImagePath: string, cwd: string): Promise<void> {
  const launcherDirectory = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDirectory, { recursive: true })
  await writeFile(join(launcherDirectory, 'orca-ide'), '#!/usr/bin/env bash\n', { mode: 0o755 })
}

function installerOptions(fixture: Fixture) {
  return {
    platform: 'linux' as const,
    isPackaged: true,
    userDataPath: join(fixture.root, 'user-data'),
    resourcesPath: join(fixture.root, 'mount', 'resources'),
    execPath: join(fixture.root, 'mount', 'orca-ide'),
    appPath: join(fixture.root, 'mount', 'resources', 'app.asar'),
    homePath: join(fixture.root, 'home'),
    processPathEnv: fixture.commandDirectory,
    appImagePath: fixture.appImagePath,
    appImageCacheRootPath: fixture.cacheRootPath,
    appImageExtractRunner: extractPayload
  }
}

describe.skipIf(process.platform === 'win32')('AppImage CLI ownership', () => {
  it('uses the mounted bundled launcher when only APPDIR is inherited', async () => {
    const fixture = await makeFixture()
    const resourcesPath = join(fixture.root, 'mounted', 'resources')
    const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    vi.stubEnv('APPIMAGE', '')
    vi.stubEnv('APPDIR', dirname(resourcesPath))

    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: join(fixture.root, 'user-data'),
      resourcesPath,
      execPath: join(dirname(resourcesPath), 'orca-ide'),
      appPath: join(resourcesPath, 'app.asar'),
      homePath: join(fixture.root, 'home'),
      processPathEnv: fixture.commandDirectory,
      commandPathOverride: fixture.commandPath
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      launcherPath
    })
    await expect(installer.install()).resolves.toMatchObject({
      state: 'installed',
      launcherPath
    })
    await expect(readlink(fixture.commandPath)).resolves.toBe(launcherPath)
  })

  it('ignores inherited APPIMAGE without the matching runtime identity', async () => {
    const fixture = await makeFixture()
    const resourcesPath = join(fixture.root, 'installed', 'resources')
    const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    vi.stubEnv('APPIMAGE', fixture.appImagePath)
    vi.stubEnv('APPDIR', '')
    const extract = vi.fn(extractPayload)

    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: join(fixture.root, 'user-data'),
      resourcesPath,
      execPath: join(fixture.root, 'installed', 'orca-ide'),
      appPath: join(resourcesPath, 'app.asar'),
      homePath: join(fixture.root, 'home'),
      processPathEnv: fixture.commandDirectory,
      appImageCacheRootPath: fixture.cacheRootPath,
      appImageExtractRunner: extract
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'unsupported',
      launcherPath: null,
      detail: expect.stringContaining('could not verify')
    })
    await expect(installer.install()).rejects.toThrow('could not verify')
    expect(extract).not.toHaveBeenCalled()
  })

  it('refuses an arbitrary resources/bin/orca-ide symlink', async () => {
    const fixture = await makeFixture()
    const foreignTarget = join(fixture.root, 'foreign', 'resources', 'bin', 'orca-ide')
    await symlink(foreignTarget, fixture.commandPath)
    const extract = vi.fn(extractPayload)
    const installer = new CliInstaller({
      ...installerOptions(fixture),
      appImageExtractRunner: extract
    })

    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'conflict' })
    await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
    await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
    expect(extract).not.toHaveBeenCalled()
  })

  it('leaves a foreign legacy resources/bin/orca symlink untouched', async () => {
    const fixture = await makeFixture()
    const legacyCommandPath = join(fixture.commandDirectory, 'orca')
    const foreignTarget = join(fixture.root, 'foreign', 'resources', 'bin', 'orca')
    await symlink(foreignTarget, legacyCommandPath)

    await expect(new CliInstaller(installerOptions(fixture)).install()).resolves.toMatchObject({
      state: 'installed'
    })
    await expect(readlink(legacyCommandPath)).resolves.toBe(foreignTarget)
  })

  it('keeps installation bound to the extracted generation', async () => {
    const fixture = await makeFixture()
    let extractedRoot: AppImageExtractedRoot | null = null
    class ReplacingAppImageInstaller extends CliInstaller {
      protected override async ensureLinuxAppImagePayload(): Promise<AppImageExtractedRoot | null> {
        extractedRoot = await super.ensureLinuxAppImagePayload()
        await writeFile(fixture.appImagePath, '#!/usr/bin/env bash\n# replacement generation\n', {
          mode: 0o755
        })
        return extractedRoot
      }
    }

    const installer = new ReplacingAppImageInstaller(installerOptions(fixture))
    const installed = await installer.install()
    const capturedRoot = extractedRoot as AppImageExtractedRoot | null

    expect(capturedRoot).not.toBeNull()
    expect(installed).toMatchObject({
      state: 'stale',
      launcherPath: capturedRoot!.stableLauncherPath
    })
    await expect(readlink(fixture.commandPath)).resolves.toBe(capturedRoot!.stableLauncherPath)
    await expect(lstat(capturedRoot!.stableLauncherPath)).resolves.toBeDefined()
    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'stale' })
  })

  it('repairs the stable endpoint without reclaiming the prior path owner', async () => {
    const fixture = await makeFixture()
    const firstInstaller = new CliInstaller(installerOptions(fixture))
    const first = await firstInstaller.install()
    const firstRoot = resolveAppImageExtractedRoot({
      appImagePath: fixture.appImagePath,
      cacheRootPath: fixture.cacheRootPath
    })!
    const relocatedPath = join(fixture.root, 'downloads', 'Orca.AppImage')
    await mkdir(dirname(relocatedPath), { recursive: true })
    await rename(fixture.appImagePath, relocatedPath)
    const relocatedFixture = { ...fixture, appImagePath: relocatedPath }
    const relocatedInstaller = new CliInstaller(installerOptions(relocatedFixture))

    await expect(relocatedInstaller.getStatus()).resolves.toMatchObject({ state: 'stale' })
    const repaired = await relocatedInstaller.install()
    const relocatedRoot = resolveAppImageExtractedRoot({
      appImagePath: relocatedPath,
      cacheRootPath: fixture.cacheRootPath
    })!

    expect(repaired).toMatchObject({ state: 'installed', launcherPath: first.launcherPath })
    await expect(readlink(fixture.commandPath)).resolves.toBe(first.launcherPath)
    await expect(lstat(relocatedRoot.payloadLauncherPath)).resolves.toBeDefined()
    // A path namespace is an ownership boundary; the relocated process cannot prove that no
    // sibling AppImage still owns the prior namespace.
    await expect(lstat(firstRoot.rootPath)).resolves.toBeDefined()
  })

  it('preserves a foreign command that appears at the final ownership fence', async () => {
    const fixture = await makeFixture()
    const predictedRoot = resolveAppImageExtractedRoot({
      appImagePath: fixture.appImagePath,
      cacheRootPath: fixture.cacheRootPath
    })!
    const ownedOldTarget = join(
      dirname(predictedRoot.rootPath),
      'a'.repeat(24),
      'resources',
      'bin',
      'orca-ide'
    )
    const foreignTarget = join(fixture.root, 'foreign', 'orca-ide')
    await symlink(ownedOldTarget, fixture.commandPath)

    class RacedInstaller extends CliInstaller {
      private inspectionCount = 0

      protected override async inspectSymlink(
        commandPath: string,
        launcherPath: string
      ): Promise<CliInstallStatus> {
        this.inspectionCount += 1
        if (this.inspectionCount === 3) {
          await unlink(commandPath)
          await symlink(foreignTarget, commandPath)
        }
        return super.inspectSymlink(commandPath, launcherPath)
      }
    }

    await expect(new RacedInstaller(installerOptions(fixture)).install()).rejects.toThrow(
      'Refusing to replace non-Orca command'
    )
    await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
    expect((await readdir(fixture.commandDirectory)).some((name) => name.includes('.orca-'))).toBe(
      false
    )
  })

  // #15081 review: the Linux reclaim rule was narrowed to extracted-cache launchers, which left a
  // deb/rpm -> AppImage migration wedged on its own leftover symlink.
  it('reclaims a symlink left by a packaged deb/rpm install', async () => {
    for (const directory of ['/opt/Orca', '/opt/orca-ide', '/opt/orca']) {
      const fixture = await makeFixture()
      await symlink(`${directory}/resources/bin/orca-ide`, fixture.commandPath)

      await expect(new CliInstaller(installerOptions(fixture)).getStatus()).resolves.toMatchObject({
        state: 'stale'
      })
    }
  })

  it('still refuses a launcher-named symlink outside the packaged install tree', async () => {
    const fixture = await makeFixture()
    await symlink('/opt/not-orca/resources/bin/orca-ide', fixture.commandPath)

    await expect(new CliInstaller(installerOptions(fixture)).getStatus()).resolves.toMatchObject({
      state: 'conflict'
    })
  })
})
