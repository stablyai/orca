import { lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
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

async function makeFixture(): Promise<{
  root: string
  userDataPath: string
  appPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-installer-'))
  const userDataPath = join(root, 'userData')
  const appPath = join(root, 'app')
  const cliEntryPath = join(appPath, 'out', 'cli', 'index.js')
  await mkdir(join(appPath, 'out', 'cli'), { recursive: true })
  await writeFile(cliEntryPath, 'console.log("orca")\n', 'utf8')
  return { root, userDataPath, appPath }
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
      expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1')
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
      expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1')

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
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
      const oldLauncherPath = join(fixture.userDataPath, 'cli', 'bin', 'orca')
      const legacyCommandPath = join(commandDir, 'orca')
      await mkdir(commandDir, { recursive: true })
      await mkdir(join(fixture.userDataPath, 'cli', 'bin'), { recursive: true })
      await writeFile(oldLauncherPath, '#!/usr/bin/env bash\n', 'utf8')
      await symlink(oldLauncherPath, legacyCommandPath)

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
      expect(installed.commandPath).toBe(join(commandDir, 'orca-ide'))
      await expect(lstat(legacyCommandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('creates a windows wrapper and updates the user PATH', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd')
    let userPath = 'C:\\Windows\\System32'
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      userPathReader: async () => userPath,
      userPathWriter: async (value) => {
        userPath = value
      }
    })

    const installed = await installer.install()
    expect(installed.state).toBe('installed')
    expect(installed.pathConfigured).toBe(true)
    expect(userPath).toContain(join(fixture.root, 'Programs', 'Orca', 'bin'))

    const wrapperContent = await readFile(installPath, 'utf8')
    expect(wrapperContent).toContain('ORCA_LAUNCHER=')
    expect(wrapperContent).toContain('orca.cmd')

    const removed = await installer.remove()
    expect(removed.state).toBe('not_installed')
    expect(userPath).not.toContain(join(fixture.root, 'Programs', 'Orca', 'bin'))
  })

  it('settles when the Windows PATH query hangs', async () => {
    vi.useFakeTimers()
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd')
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath
    })

    const promise = installer.getStatus()
    let settled = false
    void promise
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })

    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(promise).rejects.toThrow('Windows PATH command timed out')
    expect(killMock).toHaveBeenCalled()
  })

  // Why: this test creates a Unix symlink to /tmp/not-orca, which only applies on macOS/Linux.
  it.skipIf(process.platform === 'win32')(
    'refuses to replace an unknown symlink at the command path',
    async () => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, 'bin', 'orca')
      const existingTarget = '/tmp/not-orca'
      await mkdir(join(fixture.root, 'bin'), { recursive: true })
      await symlink(existingTarget, installPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        appPath: fixture.appPath,
        commandPathOverride: installPath
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        supported: true
      })
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
      await expect(readlink(installPath)).resolves.toBe(existingTarget)
    }
  )

  // Why: packaged app moves can leave a symlink to an older Orca-owned launcher;
  // those are safe to refresh, unlike arbitrary user symlinks.
  it.skipIf(process.platform === 'win32')(
    'replaces stale packaged Orca launcher symlinks',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, 'bin')
      const installPath = join(commandDir, 'orca')
      const resourcesPath = join(fixture.root, 'Current.app', 'Contents', 'Resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca')
      const oldLauncherPath = join(fixture.root, 'Old.app', 'Contents', 'Resources', 'bin', 'orca')
      await mkdir(commandDir, { recursive: true })
      await mkdir(join(resourcesPath, 'bin'), { recursive: true })
      await writeFile(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
      await symlink(oldLauncherPath, installPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: oldLauncherPath
      })
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readlink(installPath)).resolves.toBe(launcherPath)
    }
  )
})
