import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { CliInstaller } from './cli-installer'
import { makeFixture } from './cli-installer-test-fixtures'
import { resolveAppImageExtractedRoot } from './appimage-extracted-root'
import { buildLegacyAppImageCliWrapper } from './legacy-appimage-cli-wrapper'

// Match --appimage-extract's output directory under cwd.
async function fakeAppImageExtractRunner(_appImagePath: string, cwd: string): Promise<void> {
  const launcherDir = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'orca-ide'), '#!/usr/bin/env bash\n', {
    encoding: 'utf8',
    mode: 0o755
  })
}

describe('CliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.skipIf(process.platform === 'win32')(
    'uses a separate orca-dev command for default development installs',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/opt/Orca/orca-ide',
        appPath: fixture.appPath,
        homePath,
        processPathEnv: commandDir
      })

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandName).toBe('orca-dev')
      expect(installed.commandPath).toBe(join(commandDir, 'orca-dev'))
      expect(installed.launcherPath).toBe(join(fixture.userDataPath, 'cli', 'bin', 'orca-dev'))
      await expect(readlink(installed.commandPath as string)).resolves.toBe(installed.launcherPath)
      await expect(
        readFile(join(fixture.userDataPath, 'cli', 'bin', 'orca'), 'utf8')
      ).resolves.toBe(await readFile(installed.launcherPath as string, 'utf8'))
    }
  )

  it.skipIf(process.platform === 'win32')(
    're-extracts and re-points the command when the AppImage is replaced',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'orca-ide')
      const appImagePath = join(fixture.root, 'Orca.AppImage')
      const cacheRootPath = join(fixture.root, 'cache')
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      const makeInstaller = (): CliInstaller =>
        new CliInstaller({
          platform: 'linux',
          isPackaged: true,
          userDataPath: fixture.userDataPath,
          appPath: fixture.appPath,
          appImagePath,
          appImageCacheRootPath: cacheRootPath,
          appImageExtractRunner: fakeAppImageExtractRunner,
          commandPathOverride: installPath,
          processPathEnv: commandDir
        })

      const first = await makeInstaller().install()
      expect(first.state).toBe('installed')

      await writeFile(appImagePath, '#!/usr/bin/env bash\n# next version\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      await expect(makeInstaller().getStatus()).resolves.toMatchObject({ state: 'stale' })

      const second = await makeInstaller().install()
      expect(second.state).toBe('installed')
      expect(second.launcherPath).toBe(first.launcherPath)
      await expect(readlink(installPath)).resolves.toBe(second.launcherPath)
      const liveRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath
      expect((await readdir(dirname(liveRoot))).sort()).toEqual(
        [basename(liveRoot), 'source-appimage'].sort()
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'replaces and removes the legacy AppImage wrapper',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'orca-ide')
      const appImagePath = join(fixture.root, "Orca's AppImage.AppImage")
      const cacheRootPath = join(fixture.root, 'cache')
      await mkdir(commandDir, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
      await writeFile(installPath, buildLegacyAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        userDataPath: fixture.userDataPath,
        appPath: fixture.appPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath,
        appImageExtractRunner: fakeAppImageExtractRunner,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: appImagePath
      })
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readlink(installPath)).resolves.toContain(cacheRootPath)

      await installer.remove()
      await writeFile(installPath, buildLegacyAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
      await expect(lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'removes a legacy AppImage wrapper only when it names the current AppImage',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const legacyCommandPath = join(commandDir, 'orca')
      const appImagePath = join(fixture.root, 'Orca.AppImage')
      const foreignAppImagePath = join(fixture.root, 'Other.AppImage')
      const cacheRootPath = join(fixture.root, 'cache')
      await mkdir(commandDir, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      await writeFile(foreignAppImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      await writeFile(legacyCommandPath, buildLegacyAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        userDataPath: fixture.userDataPath,
        appPath: fixture.appPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath,
        appImageExtractRunner: fakeAppImageExtractRunner,
        homePath,
        processPathEnv: commandDir
      })

      await installer.install()
      await expect(lstat(legacyCommandPath)).rejects.toMatchObject({ code: 'ENOENT' })

      await writeFile(legacyCommandPath, buildLegacyAppImageCliWrapper(foreignAppImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      await installer.remove()
      await expect(readFile(legacyCommandPath, 'utf8')).resolves.toBe(
        buildLegacyAppImageCliWrapper(foreignAppImagePath)
      )
    }
  )
})
