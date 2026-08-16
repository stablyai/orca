import { chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { buildAppImageCliWrapper } from './appimage-cli-wrapper'
import { makeFixture } from './cli-installer-test-fixtures'

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

  // Why: AppImage resources live under a per-launch FUSE mount, so the
  // installed shell command must be a stable wrapper rather than a symlink.
  it.skipIf(process.platform === 'win32')(
    'creates an AppImage wrapper under the linux command path',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'orca-ide')
      const appImagePath = join(fixture.root, 'Orca.AppImage')
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        appImagePath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      const initial = await installer.getStatus()
      expect(initial).toMatchObject({
        state: 'not_installed',
        installMethod: 'wrapper',
        launcherPath: appImagePath
      })

      const installed = await installer.install()
      expect(installed).toMatchObject({
        state: 'installed',
        commandName: 'orca-ide',
        installMethod: 'wrapper',
        launcherPath: appImagePath,
        currentTarget: appImagePath,
        pathConfigured: true
      })

      const commandStats = await lstat(installPath)
      expect(commandStats.isFile()).toBe(true)
      expect(commandStats.mode & 0o111).not.toBe(0)
      await expect(readlink(installPath)).rejects.toMatchObject({ code: 'EINVAL' })
      await expect(readFile(installPath, 'utf8')).resolves.toBe(
        buildAppImageCliWrapper(appImagePath)
      )

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a stale AppImage wrapper when the AppImage path changes',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'orca-ide')
      const oldAppImagePath = join(fixture.root, 'Old-Orca.AppImage')
      const newAppImagePath = join(fixture.root, 'Orca.AppImage')
      await mkdir(commandDir, { recursive: true })
      await writeFile(installPath, buildAppImageCliWrapper(oldAppImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      await writeFile(newAppImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        appImagePath: newAppImagePath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        installMethod: 'wrapper',
        currentTarget: newAppImagePath
      })

      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readFile(installPath, 'utf8')).resolves.toBe(
        buildAppImageCliWrapper(newAppImagePath)
      )
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
    'removes a legacy linux orca symlink when installing an AppImage wrapper',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const legacyCommandPath = join(commandDir, 'orca')
      const appImagePath = join(fixture.root, 'Orca.AppImage')
      await mkdir(commandDir, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      await symlink(join('/tmp', '.mount_Orca1234', 'resources', 'bin', 'orca'), legacyCommandPath)

      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        appImagePath,
        homePath,
        processPathEnv: commandDir
      })

      const installed = await installer.install()
      expect(installed.commandPath).toBe(join(commandDir, 'orca-ide'))
      await expect(lstat(legacyCommandPath)).rejects.toMatchObject({ code: 'ENOENT' })
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
        expect(privilegedCommands[0]).toContain('ln -sfn')
        await expect(readlink(installPath)).resolves.toBe(installed.launcherPath)
      } finally {
        await chmod(protectedDir, 0o700).catch(() => undefined)
      }
    }
  )
})
