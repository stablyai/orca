import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from '../cli-installer'

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
})
