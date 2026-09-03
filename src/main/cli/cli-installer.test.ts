import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
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

// Stands in for the AppImage runtime's `--appimage-extract`, which writes the
// payload to ./squashfs-root relative to cwd.
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

  // Why: this test creates Unix symlinks and shell scripts that only apply on macOS.
  it.skipIf(process.platform === 'win32')(
    'creates a dev launcher and installs a macOS symlink in the requested path',
    async () => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, 'bin', 'orca')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        appPath: fixture.appPath,
        commandPathOverride: installPath,
        processPathEnv: join(fixture.root, 'bin')
      })

      const initial = await installer.getStatus()
      expect(initial.state).toBe('not_installed')
      expect(initial.launcherPath).toContain(join('userData', 'cli', 'bin', 'orca'))

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.pathConfigured).toBe(true)

      const launcherContent = await readFile(installed.launcherPath as string, 'utf8')
      expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"')
      expect(launcherContent).toContain(`export ORCA_USER_DATA_PATH='${fixture.userDataPath}'`)
      expect(launcherContent).toContain('export ORCA_APP_EXECUTABLE="$ELECTRON"')
      expect(launcherContent).toContain(join(fixture.appPath, 'out', 'cli', 'index.js'))

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
    }
  )

  // Why: this test creates Unix symlinks and shell scripts that only apply on Linux.
  it.skipIf(process.platform === 'win32')(
    'creates a linux symlink under the requested path and warns when PATH is missing',
    async () => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, '.local', 'bin', 'orca-ide')
      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/opt/Orca/orca-ide',
        appPath: fixture.appPath,
        commandPathOverride: installPath,
        processPathEnv: '/usr/bin'
      })

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandName).toBe('orca-ide')
      expect(installed.pathConfigured).toBe(false)
      expect(installed.detail).toContain('.local')

      const launcherContent = await readFile(installed.launcherPath as string, 'utf8')
      expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"')
      expect(launcherContent).toContain(`export ORCA_USER_DATA_PATH='${fixture.userDataPath}'`)

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
    }
  )

  // Why: dev installs are useful for validation, but they must not replace the
  // packaged `orca` / `orca-ide` commands developers rely on day to day.
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

  // Why: an AppImage's payload is only reachable through a FUSE mount that its
  // own AppRun sets up, and AppRun prepends `--no-sandbox` into node mode on
  // userns-restricted hosts (#11609). Extracting once gives the command the
  // same plain launcher a deb install ships, so registration is a symlink.
  it.skipIf(process.platform === 'win32')(
    'symlinks the linux command at the extracted AppImage launcher',
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

      const initial = await installer.getStatus()
      expect(initial).toMatchObject({ state: 'not_installed', installMethod: 'symlink' })

      const installed = await installer.install()
      expect(installed).toMatchObject({
        state: 'installed',
        commandName: 'orca-ide',
        installMethod: 'symlink',
        pathConfigured: true
      })
      // The command target remains stable while its cache endpoint advances generations.
      expect(relative(cacheRootPath, installed.launcherPath as string).split(sep)).toEqual([
        'launcher',
        'orca-ide'
      ])
      expect(installed.currentTarget).toBe(installed.launcherPath)
      await expect(readlink(installPath)).resolves.toBe(installed.launcherPath)

      const extractedRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
      await rm(extractedRoot.rootPath, { recursive: true, force: true })
      await expect(installer.getStatus()).resolves.toMatchObject({ state: 'stale' })
      const repaired = await installer.install()
      expect(repaired.state).toBe('installed')

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
      await expect(lstat(repaired.launcherPath as string)).resolves.toBeDefined()
      expect(
        existsSync(resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath)
      ).toBe(false)
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

      // An update replaces the file in place, so size and mtime both change.
      await writeFile(appImagePath, '#!/usr/bin/env bash\n# next version\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      await expect(makeInstaller().getStatus()).resolves.toMatchObject({ state: 'stale' })

      const second = await makeInstaller().install()
      expect(second.state).toBe('installed')
      expect(second.launcherPath).toBe(first.launcherPath)
      await expect(readlink(installPath)).resolves.toBe(second.launcherPath)
      // Only the live payload survives the upgrade.
      const liveRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath
      await expect(readdir(dirname(liveRoot))).resolves.toHaveLength(1)
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

  // Why: Linux renamed the public command to avoid shadowing GNOME Orca, so
  // upgrading must clean up only the old symlink owned by prior Orca installs.
  it.skipIf(process.platform === 'win32')(
    'removes the old managed linux orca symlink when installing orca-ide',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const resourcesPath = join(fixture.root, 'resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
      const oldLauncherPath = join(resourcesPath, 'bin', 'orca')
      const legacyCommandPath = join(commandDir, 'orca')
      await mkdir(commandDir, { recursive: true })
      await mkdir(join(resourcesPath, 'bin'), { recursive: true })
      await writeFile(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
      await writeFile(oldLauncherPath, '#!/usr/bin/env bash\n', 'utf8')
      await symlink(oldLauncherPath, legacyCommandPath)

      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        userDataPath: fixture.userDataPath,
        appPath: fixture.appPath,
        resourcesPath,
        homePath,
        processPathEnv: commandDir
      })

      const installed = await installer.install()
      expect(installed.commandPath).toBe(join(commandDir, 'orca-ide'))
      await expect(lstat(legacyCommandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'removes a legacy linux orca symlink when registering from an AppImage',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const legacyCommandPath = join(commandDir, 'orca')
      const appImagePath = join(fixture.root, 'Orca.AppImage')
      const cacheRootPath = join(fixture.root, 'cache')
      await mkdir(commandDir, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      const extractedRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
      await symlink(join(dirname(extractedRoot.payloadLauncherPath), 'orca'), legacyCommandPath)

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

      const installed = await installer.install()
      expect(installed.commandPath).toBe(join(commandDir, 'orca-ide'))
      await expect(lstat(legacyCommandPath)).rejects.toMatchObject({ code: 'ENOENT' })
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

  // Why: the privilegedRunner is injectable so the EACCES→osascript path can be
  // exercised in integration without spawning osascript in unit tests.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'invokes the injected privilegedRunner when install falls back to elevated permissions',
    async () => {
      const fixture = await makeFixture()
      const protectedDir = join(fixture.root, 'protected')
      await mkdir(protectedDir)
      await chmod(protectedDir, 0o500)

      const installPath = join(protectedDir, 'bin', 'orca')
      const privilegedCommands: string[] = []
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        appPath: fixture.appPath,
        commandPathOverride: installPath,
        privilegedRunner: async (command: string) => {
          privilegedCommands.push(command)
          await chmod(protectedDir, 0o700)
          const launcherPath = (await installer.getStatus()).launcherPath as string
          await mkdir(dirname(installPath), { recursive: true })
          await symlink(launcherPath, installPath)
        },
        processPathEnv: dirname(installPath)
      })

      try {
        const installed = await installer.install()

        expect(installed.state).toBe('installed')
        expect(installed.pathConfigured).toBe(true)
        expect(privilegedCommands).toHaveLength(1)
        expect(privilegedCommands[0]).toContain('mkdir -p')
        expect(privilegedCommands[0]).toContain('ln -s')
        expect(privilegedCommands[0]).toContain('/bin/ln -P')
        expect(privilegedCommands[0]).not.toContain('mv -f')
        await expect(readlink(installPath)).resolves.toBe(installed.launcherPath)
      } finally {
        await chmod(protectedDir, 0o700).catch(() => undefined)
      }
    }
  )
})
