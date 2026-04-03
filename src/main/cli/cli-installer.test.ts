import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a dev launcher and installs a macOS symlink in the requested path', async () => {
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
  })

  it('creates a linux symlink under the requested path and warns when PATH is missing', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, '.local', 'bin', 'orca')
    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: '/opt/Orca/orca',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      processPathEnv: '/usr/bin'
    })

    const installed = await installer.install()
    expect(installed.state).toBe('installed')
    expect(installed.pathConfigured).toBe(false)
    expect(installed.detail).toContain('.local')

    const launcherContent = await readFile(installed.launcherPath as string, 'utf8')
    expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1')

    const removed = await installer.remove()
    expect(removed.state).toBe('not_installed')
  })

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

  it('reports stale when a different symlink already exists', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'bin', 'orca')
    await mkdir(join(fixture.root, 'bin'), { recursive: true })
    await symlink('/tmp/not-orca', installPath)

    const installer = new CliInstaller({
      platform: 'darwin',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
      appPath: fixture.appPath,
      commandPathOverride: installPath
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'stale',
      supported: true
    })
  })
})
