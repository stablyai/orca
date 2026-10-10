import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'

const createdRoots: string[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)))
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-unreadable-symlink-'))
  createdRoots.push(root)
  const protectedDirectory = join(root, 'protected')
  const commandPath = join(protectedDirectory, 'orca')
  const appPath = join(root, 'app')
  await mkdir(protectedDirectory)
  await mkdir(join(appPath, 'out', 'cli'), { recursive: true })
  await writeFile(join(appPath, 'out', 'cli', 'index.js'), 'console.log("orca")\n')
  cleanups.push(async () => {
    await chmod(protectedDirectory, 0o700)
    await lchmod(commandPath, 0o755)
  })
  return { root, protectedDirectory, commandPath, appPath }
}

// Why: 0300 denies readlink(2) to the owner too, standing in for the root-owned 0700 link a
// `umask 077` privileged registration left behind for the non-root user (#19120).
async function makeUnreadable(path: string): Promise<void> {
  await lchmod(path, 0o300)
  await expect(readlink(path)).rejects.toMatchObject({ code: 'EACCES' })
}

function createInstaller(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  commands: string[] = []
) {
  return new CliInstaller({
    platform: 'darwin',
    isPackaged: false,
    userDataPath: join(fixture.root, 'user-data'),
    appPath: fixture.appPath,
    execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
    commandPathOverride: fixture.commandPath,
    processPathEnv: fixture.protectedDirectory,
    privilegedRunner: async (command) => {
      commands.push(command)
      await chmod(fixture.protectedDirectory, 0o700)
      // Root can read any symlink; restore that ability for the non-root test runner.
      await lchmod(fixture.commandPath, 0o700).catch(() => undefined)
      const result = await runProcess({ program: '/bin/sh', args: ['-c', `umask 077; ${command}`] })
      if (result.code !== 0) {
        throw new Error(result.stderr || `Privileged shell exited ${result.code}.`)
      }
    }
  })
}

describe.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)(
  'macOS CLI command symlink readability',
  () => {
    it('publishes a world-readable symlink even when the privileged shell runs with umask 077', async () => {
      const fixture = await createFixture()
      await chmod(fixture.protectedDirectory, 0o500)
      const installed = await createInstaller(fixture).install()

      expect(installed.state).toBe('installed')
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)
    })

    it('reports an unreadable Orca symlink as stale instead of throwing EACCES', async () => {
      const fixture = await createFixture()
      const { launcherPath } = await createInstaller(fixture).getStatus()
      expect(launcherPath).toEqual(expect.any(String))
      await symlink(launcherPath ?? '', fixture.commandPath)
      await makeUnreadable(fixture.commandPath)

      await expect(createInstaller(fixture).getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: null
      })
    })

    it('repairs an unreadable Orca app symlink through the privileged transaction', async () => {
      const fixture = await createFixture()
      await symlink('/Applications/Orca.app/Contents/Resources/bin/orca', fixture.commandPath)
      await makeUnreadable(fixture.commandPath)
      await chmod(fixture.protectedDirectory, 0o500)
      const commands: string[] = []

      const installed = await createInstaller(fixture, commands).install()

      expect(installed.state).toBe('installed')
      expect(commands).toHaveLength(1)
      await expect(readlink(fixture.commandPath)).resolves.toBe(installed.launcherPath)
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)
    })

    it('refuses to replace an unreadable symlink that does not point at an Orca launcher', async () => {
      const fixture = await createFixture()
      await symlink('/usr/local/opt/other-tool/bin/orca', fixture.commandPath)
      await makeUnreadable(fixture.commandPath)
      await chmod(fixture.protectedDirectory, 0o500)

      const commands: string[] = []

      await expect(createInstaller(fixture, commands).install()).rejects.toThrow()
      expect(commands).toHaveLength(1)
      await lchmod(fixture.commandPath, 0o755)
      await expect(readlink(fixture.commandPath)).resolves.toBe(
        '/usr/local/opt/other-tool/bin/orca'
      )
    })
  }
)
