import { lstat, mkdir, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { makeFixture } from './installation/cli-installer-test-fixtures'

import { buildLegacyAppImageCliWrapper } from './appimage/legacy-appimage-cli-wrapper'

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
})
