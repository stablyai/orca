import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))

import { CliInstaller } from './cli-installer'
import {
  installLinuxBareOrcaDispatcher,
  removeLinuxBareOrcaDispatcher
} from './linux-bare-orca-dispatcher'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeProgram(path: string, output: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `#!/bin/sh\necho "${output} $*"\n`, 'utf8')
  await chmod(path, 0o755)
}

/** A home with Orca's dispatcher installed, and a second `orca` (as GNOME's screen reader). */
async function makeFixture(): Promise<{
  root: string
  homePath: string
  resourcesPath: string
  launcherPath: string
  dispatcherPath: string
  screenReaderDir: string
  toolsDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca bare dispatcher '))
  created.push(root)
  const homePath = join(root, 'home')
  const resourcesPath = join(root, 'resources')
  const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
  const screenReaderDir = join(root, 'usr-bin')
  await writeProgram(launcherPath, 'ORCA_CLI')
  await writeProgram(join(screenReaderDir, 'orca'), 'SCREEN_READER')
  // Only bash on the base PATH, so a runner's own /usr/bin/orca cannot answer.
  const toolsDir = join(root, 'tools')
  await mkdir(toolsDir)
  const bash = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  await symlink(bash, join(toolsDir, 'bash'))
  const result = await installLinuxBareOrcaDispatcher({
    resourcesPath,
    homePath,
    appImagePath: null
  })
  expect(result.state).toBe('installed')
  return {
    root,
    homePath,
    resourcesPath,
    launcherPath,
    dispatcherPath: result.dispatcherPath,
    screenReaderDir,
    toolsDir
  }
}

function runOrca(
  fixture: { homePath: string; toolsDir: string },
  pathDirs: string[],
  env: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('orca', ['status'], {
    encoding: 'utf8',
    env: { HOME: fixture.homePath, PATH: [...pathDirs, fixture.toolsDir].join(':'), ...env },
    timeout: 10_000
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe.runIf(process.platform !== 'win32')('the bare orca dispatcher as a shell runs it', () => {
  it("leaves another `orca` on PATH (GNOME's screen reader) to everyone but Orca's children", async () => {
    const fixture = await makeFixture()
    const binDir = join(fixture.homePath, '.local', 'bin')

    expect(runOrca(fixture, [binDir, fixture.screenReaderDir]).stdout).toBe(
      'SCREEN_READER status\n'
    )
    expect(
      runOrca(fixture, [binDir, fixture.screenReaderDir], { ORCA_PANE_KEY: 'tab:1' }).stdout
    ).toBe('ORCA_CLI status\n')
    expect(
      runOrca(fixture, [binDir, fixture.screenReaderDir], { ORCA_CLI_BIN_DIR: '/x' }).stdout
    ).toBe('ORCA_CLI status\n')
  })

  it('reaches this app when no other `orca` is on PATH', async () => {
    const fixture = await makeFixture()
    const binDir = join(fixture.homePath, '.local', 'bin')

    expect(runOrca(fixture, ['', binDir]).stdout).toBe('ORCA_CLI status\n')
  })

  it('says Orca is gone instead of failing to exec once the launcher is removed', async () => {
    const fixture = await makeFixture()
    const binDir = join(fixture.homePath, '.local', 'bin')
    await rm(fixture.resourcesPath, { recursive: true, force: true })

    const alone = runOrca(fixture, [binDir], { ORCA_PANE_KEY: 'tab:1' })
    expect(alone.status).toBe(127)
    expect(alone.stdout).toBe('')
    expect(alone.stderr).toContain(`Orca is no longer installed at ${fixture.launcherPath}`)
    expect(alone.stderr).toContain(`Remove ${fixture.dispatcherPath}`)

    expect(runOrca(fixture, [binDir, fixture.screenReaderDir]).stdout).toBe(
      'SCREEN_READER status\n'
    )
  })

  async function addSecondDispatcher(fixture: { root: string; dispatcherPath: string }) {
    const otherBin = join(fixture.root, 'other-home', '.local', 'bin')
    await mkdir(otherBin, { recursive: true })
    await writeFile(join(otherBin, 'orca'), await readFile(fixture.dispatcherPath, 'utf8'), {
      mode: 0o755
    })
    return otherBin
  }

  it('skips a second Orca dispatcher ahead of it and reaches the real `orca`', async () => {
    const fixture = await makeFixture()
    const otherBin = await addSecondDispatcher(fixture)
    const binDir = join(fixture.homePath, '.local', 'bin')

    expect(runOrca(fixture, [otherBin, binDir, fixture.screenReaderDir]).stdout).toBe(
      'SCREEN_READER status\n'
    )
    expect(runOrca(fixture, [binDir, otherBin, fixture.screenReaderDir]).stdout).toBe(
      'SCREEN_READER status\n'
    )
  })

  it.each(['ORCA_PANE_KEY', 'ORCA_CLI_BIN_DIR', 'ORCA_USER_DATA_PATH'])(
    'never starts the screen reader for Orca children (%s) once Orca is gone',
    async (variable) => {
      const fixture = await makeFixture()
      const otherBin = await addSecondDispatcher(fixture)
      await rm(fixture.resourcesPath, { recursive: true, force: true })

      const result = runOrca(
        fixture,
        [otherBin, join(fixture.homePath, '.local', 'bin'), fixture.screenReaderDir],
        { [variable]: 'set' }
      )
      expect(result.status).toBe(127)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Orca is no longer installed')
    }
  )

  it('finds the real `orca` in a PATH folder with spaces', async () => {
    const fixture = await makeFixture()
    const spaced = join(fixture.root, 'screen reader bin')
    await writeProgram(join(spaced, 'orca'), 'SPACED')

    expect(runOrca(fixture, [join(fixture.homePath, '.local', 'bin'), spaced]).stdout).toBe(
      'SPACED status\n'
    )
  })

  it('ignores empty and relative PATH entries, which depend on the caller folder', async () => {
    const fixture = await makeFixture()
    await writeProgram(join(fixture.root, 'relative', 'orca'), 'RELATIVE')

    const result = spawnSync(fixture.dispatcherPath, ['status'], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        HOME: fixture.homePath,
        PATH: ['', '.', 'relative', fixture.toolsDir].join(':')
      },
      timeout: 10_000
    })
    expect(result.stdout).toBe('ORCA_CLI status\n')
  })

  it('skips a symlink to itself on PATH', async () => {
    const fixture = await makeFixture()
    const linkDir = join(fixture.root, 'linked')
    await mkdir(linkDir)
    await symlink(fixture.dispatcherPath, join(linkDir, 'orca'))

    expect(
      runOrca(fixture, [linkDir, join(fixture.homePath, '.local', 'bin'), fixture.screenReaderDir])
        .stdout
    ).toBe('SCREEN_READER status\n')
  })

  it.skipIf(process.getuid?.() === 0)(
    'runs an unreadable candidate as the real `orca` rather than skipping it',
    async () => {
      const fixture = await makeFixture()
      const lockedDir = join(fixture.root, 'locked')
      await writeProgram(join(lockedDir, 'orca'), 'LOCKED')
      await chmod(join(lockedDir, 'orca'), 0o111)

      const result = runOrca(fixture, [
        join(fixture.homePath, '.local', 'bin'),
        lockedDir,
        fixture.screenReaderDir
      ])
      // Exec'd (and refused by the kernel/shell), never passed over for the next `orca`.
      expect(result.stdout).not.toContain('SCREEN_READER')
      expect(result.status).not.toBe(0)
    }
  )

  it('never loops when the only other `orca` is another dispatcher', async () => {
    const fixture = await makeFixture()
    const otherBin = await addSecondDispatcher(fixture)
    await rm(fixture.resourcesPath, { recursive: true, force: true })

    const result = runOrca(fixture, [join(fixture.homePath, '.local', 'bin'), otherBin])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('Orca is no longer installed')
  })

  it('adds nothing to the environment of the `orca` it hands over to', async () => {
    const fixture = await makeFixture()
    const otherBin = await addSecondDispatcher(fixture)
    await writeFile(
      join(fixture.screenReaderDir, 'orca'),
      "#!/bin/sh\nenv | grep '^ORCA_' || echo NO_ORCA_ENV\n",
      { mode: 0o755 }
    )

    const result = runOrca(fixture, [
      otherBin,
      join(fixture.homePath, '.local', 'bin'),
      fixture.screenReaderDir
    ])
    expect(result.stdout).toBe('NO_ORCA_ENV\n')
  })
})

describe.runIf(process.platform !== 'win32')('removing the bare orca dispatcher', () => {
  it("removes Orca's dispatcher and keeps a user's own `orca`", async () => {
    const fixture = await makeFixture()

    await expect(removeLinuxBareOrcaDispatcher(fixture.homePath)).resolves.toBe(true)
    expect(existsSync(fixture.dispatcherPath)).toBe(false)
    await expect(removeLinuxBareOrcaDispatcher(fixture.homePath)).resolves.toBe(false)

    await writeProgram(fixture.dispatcherPath, 'MINE')
    await expect(removeLinuxBareOrcaDispatcher(fixture.homePath)).resolves.toBe(false)
    expect(await readFile(fixture.dispatcherPath, 'utf8')).toContain('MINE')
  })

  it('goes with the `orca` command when the user removes it', async () => {
    const fixture = await makeFixture()
    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: join(fixture.root, 'userData'),
      appPath: join(fixture.root, 'app'),
      resourcesPath: fixture.resourcesPath,
      homePath: fixture.homePath,
      processPathEnv: join(fixture.homePath, '.local', 'bin')
    })
    await installer.install()

    await installer.remove()

    expect(existsSync(fixture.dispatcherPath)).toBe(false)
  })
})
