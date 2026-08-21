import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
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
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

describe('CliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Why: on Apple Silicon, /usr/local/bin does not exist by default. The installer
  // must fall back to ~/.local/bin (user-writable, no sudo) rather than failing
  // silently when the parent directory is absent.
  it.skipIf(process.platform === 'win32')(
    'falls back to ~/.local/bin/mcode on macOS when /usr/local/bin does not exist',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      // Simulate arm64: point defaultMacCommandPath at a dir that does not exist
      // in the fixture so existsSync(dirname(...)) returns false.
      const absentUsrLocalBin = join(fixture.root, 'usr', 'local', 'bin', 'mcode')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: absentUsrLocalBin,
        processPathEnv: join(homePath, '.local', 'bin')
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(join(homePath, '.local', 'bin', 'mcode'))
      expect(status.state).toBe('not_installed')
      expect(status.supported).toBe(true)

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandPath).toBe(join(homePath, '.local', 'bin', 'mcode'))
      expect(installed.pathConfigured).toBe(true)
    }
  )

  // Why: on Intel Macs /usr/local/bin exists, so the installer must keep using
  // it as the canonical path and not regress to ~/.local/bin.
  it.skipIf(process.platform === 'win32')(
    'uses /usr/local/bin/mcode on macOS when /usr/local/bin exists',
    async () => {
      const fixture = await makeFixture()
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      await mkdir(usrLocalBin, { recursive: true })

      const installPath = join(usrLocalBin, 'mcode')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        defaultMacCommandPath: installPath,
        processPathEnv: usrLocalBin
      })

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandPath).toBe(installPath)
      expect(installed.pathConfigured).toBe(true)
    }
  )

  // Why: users can have a managed MCode command in ~/.local/bin even when
  // /usr/local/bin exists; Settings must follow the shell-visible command.
  it.skipIf(process.platform === 'win32')(
    'uses an existing managed macOS mcode command from the shell PATH before /usr/local/bin',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.state).toBe('installed')
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.pathConfigured).toBe(true)

      const installed = await installer.install()
      expect(installed.commandPath).toBe(userInstallPath)
      await expect(readlink(userInstallPath)).resolves.toBe(launcherPath)
      await expect(lstat(defaultInstallPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  // Why: POSIX command lookup skips broken symlinks and keeps searching PATH,
  // so a stale earlier artifact must not steal status from the install path.
  it.skipIf(process.platform === 'win32')(
    'skips a broken managed macOS mcode symlink before /usr/local/bin',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      const oldLauncherPath = join(fixture.root, 'Old.app', 'Contents', 'Resources', 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(oldLauncherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status).toMatchObject({
        commandPath: defaultInstallPath,
        state: 'not_installed',
        currentTarget: null
      })

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readlink(userInstallPath)).resolves.toBe(oldLauncherPath)
    }
  )

  // Why: PATH lookup stops at the first existing command; a later managed
  // ~/.local/bin/mcode must not steal status from /usr/local/bin/mcode.
  it.skipIf(process.platform === 'win32')(
    'keeps the default macOS command when a managed mcode appears later on PATH',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(launcherPath, defaultInstallPath)
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.state).toBe('installed')
    }
  )

  // Why: shells skip missing PATH entries, so a managed command later in PATH
  // is still the shell-visible MCode command until the default path is installed.
  it.skipIf(process.platform === 'win32')(
    'uses a later managed macOS mcode command when the default command is missing',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.state).toBe('installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(userInstallPath)
      await expect(lstat(defaultInstallPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  // Why: bash/zsh skip non-executable PATH entries even at MCode's configured
  // install slot, then keep looking for a runnable command later in PATH.
  it.skipIf(process.platform === 'win32')(
    'uses a later managed macOS mcode command when the default command is not executable',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(defaultInstallPath, '#!/usr/bin/env bash\necho other-mcode\n', 'utf8')
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.state).toBe('installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(userInstallPath)
      await expect(readFile(defaultInstallPath, 'utf8')).resolves.toContain('other-mcode')
    }
  )

  // Why: a non-MCode command after an empty default install slot can be shadowed
  // by installing the default path without replacing the user's command.
  it.skipIf(process.platform === 'win32')(
    'installs the default macOS command instead of replacing an unmanaged later command',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-mcode\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.state).toBe('not_installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-mcode')
    }
  )

  // Why: an off-PATH ~/.local/bin/mcode must not hijack CLI registration and
  // leave the shell-visible /usr/local/bin command missing.
  it.skipIf(process.platform === 'win32')(
    'ignores managed macOS mcode commands that are not visible on the shell PATH',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: usrLocalBin
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.pathConfigured).toBe(true)
      expect(status.state).toBe('not_installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readlink(userInstallPath)).resolves.toBe(launcherPath)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a conflict for an unmanaged macOS mcode that shadows the install path',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-mcode\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.state).toBe('conflict')
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-MCode command')
      await expect(lstat(defaultInstallPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-mcode')
    }
  )

  // Why: bash/zsh skip non-executable PATH entries, so reporting them as a
  // conflict would block a valid later install path the shell would use.
  it.skipIf(process.platform === 'win32')(
    'skips a non-executable unmanaged macOS mcode before the install path',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'mcode')
      const userInstallPath = join(userLocalBin, 'mcode')
      const launcherPath = join(resourcesPath, 'bin', 'mcode')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-mcode\n', 'utf8')

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.state).toBe('not_installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-mcode')
    }
  )

  // Why: when macCommandPath falls back to ~/.local/bin/mcode on arm64, commandName
  // must still be 'mcode' (not 'mcode-ide' which is Linux-only).
  it.skipIf(process.platform === 'win32')(
    'reports commandName as mcode (not mcode-ide) when falling back to ~/.local/bin on macOS',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const absentUsrLocalBin = join(fixture.root, 'usr', 'local', 'bin', 'mcode')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: absentUsrLocalBin,
        processPathEnv: join(homePath, '.local', 'bin')
      })

      const status = await installer.getStatus()
      expect(status.commandName).toBe('mcode')
    }
  )

  // Why: macCommandPath is resolved at construction — getStatus() must return the
  // same commandPath on repeated calls without re-running existsSync.
  it.skipIf(process.platform === 'win32')(
    'resolves macCommandPath once at construction — commandPath stable across repeated getStatus()',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const absentUsrLocalBin = join(fixture.root, 'usr', 'local', 'bin', 'mcode')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: absentUsrLocalBin,
        processPathEnv: join(homePath, '.local', 'bin')
      })

      const s1 = await installer.getStatus()
      await mkdir(dirname(absentUsrLocalBin), { recursive: true })
      const s2 = await installer.getStatus()
      const s3 = await installer.getStatus()

      expect(s1.commandPath).toBe(s2.commandPath)
      expect(s2.commandPath).toBe(s3.commandPath)
      expect(s1.commandPath).toBe(join(homePath, '.local', 'bin', 'mcode'))
    }
  )

  // Why: the arm64 fallback must apply for packaged builds, not just dev launchers.
  it.skipIf(process.platform === 'win32')(
    'resolves to ~/.local/bin/mcode on arm64 even when isPackaged is true',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const absentUsrLocalBin = join(fixture.root, 'usr', 'local', 'bin', 'mcode')
      const resourcesPath = join(fixture.root, 'resources')
      const bundledLauncher = join(resourcesPath, 'bin', 'mcode')
      await mkdir(join(resourcesPath, 'bin'), { recursive: true })
      await writeFile(bundledLauncher, '#!/usr/bin/env bash\necho mcode\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/MCode.app/Contents/MacOS/MCode',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: absentUsrLocalBin,
        processPathEnv: join(homePath, '.local', 'bin')
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(join(homePath, '.local', 'bin', 'mcode'))
      expect(status.supported).toBe(true)
    }
  )
})
