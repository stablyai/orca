import {
  chmod,
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
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'
import { buildUnixDevLauncher } from './cli-dev-launcher'
import { buildMacPrivilegedSymlinkTransaction } from './cli-command-filesystem-transaction'
import { quoteShell } from './cli-install-path-format'

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
      expect((await lstat(fixture.commandPath)).mode & 0o777).toBe(0o755)
      expect((await lstat(fixture.protectedDirectory)).mode & 0o777).toBe(0o700)
      expect(await readdir(fixture.protectedDirectory)).toEqual(['orca'])

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
      expect(commands).toHaveLength(2)
      expect(commands.every((command) => command.includes('/bin/ln -P'))).toBe(true)
      expect(commands.every((command) => !command.includes('mv -f'))).toBe(true)
    })

    it('creates public directories and a readable link while keeping staging private', async () => {
      const fixture = await createPrivilegedFixture()
      const commandDirectory = join(fixture.root, 'new local', 'bin')
      const commandPath = join(commandDirectory, 'orca')
      const contents = join(fixture.root, "Orca's Test.app", 'Contents')
      const launcherPath = join(contents, 'Resources', 'bin', 'orca')
      const electronPath = join(contents, 'MacOS', 'Orca')
      await mkdir(join(contents, 'Resources', 'bin'), { recursive: true })
      await mkdir(join(contents, 'MacOS'), { recursive: true })
      await writeFile(launcherPath, await readFile('resources/darwin/bin/orca'))
      await chmod(launcherPath, 0o751)
      await writeFile(electronPath, '#!/bin/sh\nprintf "reached-electron\\n"\n', { mode: 0o755 })

      const command = buildMacPrivilegedSymlinkTransaction({
        action: 'install',
        commandPath,
        launcherPath,
        expected: null,
        expectedFileSha256: null,
        expectedRawSymlinkTarget: null
      })
      // Inspect staging before publication removes it.
      const inspectDirectories =
        `/usr/bin/find ${quoteShell(commandDirectory)} -mindepth 1 -type d ` +
        `-exec /usr/bin/stat -f '%Lp' {} \\; && /bin/ln -s`
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', `umask 077; ${command.replace('/bin/ln -s', inspectDirectories)}`]
      })
      expect(result).toMatchObject({ code: 0, stdout: '700\n700\n', stderr: '' })
      expect((await lstat(join(fixture.root, 'new local'))).mode & 0o777).toBe(0o755)
      expect((await lstat(commandDirectory)).mode & 0o777).toBe(0o755)
      expect((await lstat(commandPath)).mode & 0o777).toBe(0o755)
      expect((await lstat(launcherPath)).mode & 0o777).toBe(0o751)
      await expect(readlink(commandPath)).resolves.toBe(launcherPath)
      expect(await readdir(commandDirectory)).toEqual(['orca'])
      await expect(
        runProcess({ program: commandPath, args: ['--version'] })
      ).resolves.toMatchObject({
        code: 0,
        stdout: 'reached-electron\n',
        stderr: ''
      })
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
        buildUnixDevLauncher('/Applications/Old.app/Contents/MacOS/Orca', oldCliPath, 'user-data')
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

    it.each(['directory', 'link permissions'])(
      'restores the displaced command when publication %s setup fails',
      async (failure) => {
        const fixture = await createPrivilegedFixture()
        const staleTarget = join(fixture.userDataPath, 'cli', 'bin', 'old', 'orca')
        await symlink(staleTarget, fixture.commandPath)
        let injectedFailure = false
        const installer = new CliInstaller({
          ...fixtureInstallerOptions(fixture),
          privilegedRunner: async (command) => {
            await chmod(fixture.protectedDirectory, 0o700)
            const sabotaged =
              failure === 'directory'
                ? command.replace(/\/bin\/mkdir ('[^']*\/publish')/, '/usr/bin/false')
                : command.replace('/bin/chmod -h 755', '/usr/bin/false')
            injectedFailure = sabotaged !== command
            await executePrivilegedShell(sabotaged)
          }
        })

        await chmod(fixture.protectedDirectory, 0o500)
        await expect(installer.install()).rejects.toThrow()
        expect(injectedFailure).toBe(true)
        await expect(readlink(fixture.commandPath)).resolves.toBe(staleTarget)
        expect(
          (await readdir(fixture.protectedDirectory)).some((name) => name.startsWith('.orca-cli-'))
        ).toBe(false)
      }
    )
  }
)
