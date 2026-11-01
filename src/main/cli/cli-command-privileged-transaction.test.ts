import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'
import { buildUnixCliLauncher } from './cli-dev-launcher'

const createdRoots: string[] = []
const protectedDirectories: string[] = []

afterEach(async () => {
  await Promise.all(protectedDirectories.splice(0).map((path) => chmod(path, 0o700)))
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function createPrivilegedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-privileged-transaction-'))
  createdRoots.push(root)
  const protectedDirectory = join(root, 'protected')
  protectedDirectories.push(protectedDirectory)
  const commandPath = join(protectedDirectory, 'orca')
  const userDataPath = join(root, 'user-data')
  const appPath = join(root, 'app')
  await mkdir(protectedDirectory)
  await mkdir(join(appPath, 'out', 'cli'), { recursive: true })
  await writeFile(join(appPath, 'out', 'cli', 'index.js'), 'console.log("orca")\n')
  return { root, protectedDirectory, commandPath, userDataPath, appPath }
}

async function executePrivilegedShell(command: string): Promise<void> {
  const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
  if (result.code !== 0) {
    const error = new Error(
      result.stderr || result.stdout || `Privileged shell exited ${result.code}.`
    )
    Object.assign(error, { code: result.code, stderr: result.stderr })
    throw error
  }
}

function fixtureInstallerOptions(fixture: Awaited<ReturnType<typeof createPrivilegedFixture>>) {
  return {
    platform: 'darwin' as const,
    isPackaged: false,
    userDataPath: fixture.userDataPath,
    appPath: fixture.appPath,
    execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
    commandPathOverride: fixture.commandPath,
    processPathEnv: fixture.protectedDirectory
  }
}

describe.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)(
  'macOS privileged CLI command transaction',
  () => {
    it('installs and removes through the generated no-overwrite shell transaction', async () => {
      const fixture = await createPrivilegedFixture()
      const commands: string[] = []
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          commands.push(command)
          await chmod(fixture.protectedDirectory, 0o700)
          await executePrivilegedShell(command)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      await expect(readlink(fixture.commandPath)).resolves.toBe(installed.launcherPath)
      // Why: macOS enforces a symlink's own mode on readlink; a 0700 link is unreadable to other users.
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
      expect(commands).toHaveLength(2)
      expect(commands.every((command) => command.includes('/bin/ln -P'))).toBe(true)
      expect(commands.every((command) => !command.includes('mv -f'))).toBe(true)
    })

    it('restores a trailing-newline symlink inserted after privileged inspection', async () => {
      const fixture = await createPrivilegedFixture()
      const staleTarget = join(fixture.userDataPath, 'cli', 'bin', 'old', 'orca')
      const foreignTarget = `${staleTarget}\n`
      await symlink(staleTarget, fixture.commandPath)
      const original = await lstat(fixture.commandPath, { bigint: true })
      let raced = false
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          if (!raced) {
            raced = true
            await unlink(fixture.commandPath)
            await symlink(foreignTarget, fixture.commandPath)
          }
          const replacement = await lstat(fixture.commandPath, { bigint: true })
          await executePrivilegedShell(
            command.replace(
              `${original.dev}:${original.ino}`,
              `${replacement.dev}:${replacement.ino}`
            )
          )
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).rejects.toThrow()
      await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
      expect(
        (await readdir(fixture.protectedDirectory)).some((name) => name.startsWith('.orca-cli-'))
      ).toBe(false)
    })

    it('restores a managed file changed in place after privileged inspection', async () => {
      const fixture = await createPrivilegedFixture()
      const oldCliPath = join(fixture.root, 'old', 'out', 'cli', 'index.js')
      await writeFile(
        fixture.commandPath,
        buildUnixCliLauncher('/Applications/Old.app/Contents/MacOS/Orca', oldCliPath, 'user-data')
      )
      const foreignContent = 'foreign command written into the inspected inode'
      let raced = false
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          if (!raced) {
            raced = true
            await writeFile(fixture.commandPath, foreignContent)
          }
          await executePrivilegedShell(command)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).rejects.toThrow()
      await expect(readFile(fixture.commandPath, 'utf8')).resolves.toBe(foreignContent)
      expect(
        (await readdir(fixture.protectedDirectory)).some((name) => name.startsWith('.orca-cli-'))
      ).toBe(false)
    })

    it('creates missing parent directories readable by the user', async () => {
      const fixture = await createPrivilegedFixture()
      const commandPath = join(fixture.protectedDirectory, 'nested', 'bin', 'orca')
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        commandPathOverride: commandPath,
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          await executePrivilegedShell(command)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      expect((await lstat(join(fixture.protectedDirectory, 'nested'))).mode & 0o777).toBe(0o755)
      expect((await lstat(join(fixture.protectedDirectory, 'nested', 'bin'))).mode & 0o777).toBe(
        0o755
      )
    })

    it('makes an unreadable link to the current launcher readable with one privileged step', async () => {
      const fixture = await createPrivilegedFixture()
      const commands: string[] = []
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          commands.push(command)
          await executePrivilegedShell(command)
        }
      })
      const launcherPath = (await installer.getStatus()).launcherPath
      await symlink(String(launcherPath), fixture.commandPath)
      await lchmod(fixture.commandPath, 0o300)
      await expect(readlink(fixture.commandPath)).rejects.toMatchObject({ code: 'EACCES' })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: null
      })
      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain('/bin/chmod -h 755')
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)
      await expect(readlink(fixture.commandPath)).resolves.toBe(launcherPath)
    })

    it('repairs an unreadable link to an older Orca launcher through the transaction', async () => {
      const fixture = await createPrivilegedFixture()
      await symlink('/Applications/Old Orca.app/Contents/Resources/bin/orca', fixture.commandPath)
      await lchmod(fixture.commandPath, 0o300)
      const commands: string[] = []
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          commands.push(command)
          await chmod(fixture.protectedDirectory, 0o700)
          await executePrivilegedShell(command)
          await chmod(fixture.protectedDirectory, 0o500)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(commands).toHaveLength(2)
      await expect(readlink(fixture.commandPath)).resolves.toBe(installed.launcherPath)
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)
    })

    it('refuses an unreadable symlink that is not an Orca launcher once root makes it readable', async () => {
      const fixture = await createPrivilegedFixture()
      const foreignTarget = '/opt/other/bin/orca'
      await symlink(foreignTarget, fixture.commandPath)
      await lchmod(fixture.commandPath, 0o300)
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: executePrivilegedShell
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).rejects.toThrow(/Refusing to replace non-Orca command/)
      await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
      expect(
        (await readdir(fixture.protectedDirectory)).some((name) => name.startsWith('.orca-cli-'))
      ).toBe(false)
    })

    it('restores the displaced command when publication setup fails', async () => {
      const fixture = await createPrivilegedFixture()
      const staleTarget = join(fixture.userDataPath, 'cli', 'bin', 'old', 'orca')
      await symlink(staleTarget, fixture.commandPath)
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          const sabotaged = command.replace(/\/bin\/mkdir ('[^']*\/publish')/, '/usr/bin/false')
          expect(sabotaged).not.toBe(command)
          await executePrivilegedShell(sabotaged)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).rejects.toThrow()
      await expect(readlink(fixture.commandPath)).resolves.toBe(staleTarget)
      expect(
        (await readdir(fixture.protectedDirectory)).some((name) => name.startsWith('.orca-cli-'))
      ).toBe(false)
    })
  }
)
