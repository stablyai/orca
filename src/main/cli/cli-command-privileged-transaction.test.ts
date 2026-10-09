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

import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from './cli-installer'
import { buildUnixDevLauncher } from './cli-dev-launcher'
import {
  buildMacPrivilegedSymlinkTransaction,
  inspectStableCommand
} from './cli-command-filesystem-transaction'

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

// Why: Node's lchmod opens the link, so it can't restore a mode-000 link; chmod -h works on the link itself.
async function chmodLink(path: string, mode: string): Promise<void> {
  const result = await runProcess({ program: '/bin/chmod', args: ['-h', mode, path] })
  expect(result.code, result.stderr).toBe(0)
}

async function linkMode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777
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

    it('replaces a managed launcher file through the privileged transaction', async () => {
      const fixture = await createPrivilegedFixture()
      const oldCliPath = join(fixture.root, 'old', 'out', 'cli', 'index.js')
      await writeFile(
        fixture.commandPath,
        buildUnixDevLauncher('/Applications/Old.app/Contents/MacOS/Orca', oldCliPath, 'user-data')
      )
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          await executePrivilegedShell(command)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      await expect(readlink(fixture.commandPath)).resolves.toBe(installed.launcherPath)
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

    it('restores the displaced command when publication setup fails', async () => {
      const fixture = await createPrivilegedFixture()
      const staleTarget = join(fixture.userDataPath, 'cli', 'bin', 'old', 'orca')
      await symlink(staleTarget, fixture.commandPath)
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          const sabotaged = command.replace(
            /\/bin\/mkdir -m 700 ('[^']*\/publish')/,
            '/usr/bin/false'
          )
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

describe.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)(
  'macOS unreadable CLI command symlink',
  () => {
    async function createUnreadableLinkFixture(target: 'launcher' | 'foreign' | 'dangling') {
      const fixture = await createPrivilegedFixture()
      const commands: string[] = []
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          commands.push(command)
          await chmod(fixture.protectedDirectory, 0o700)
          // Why: the test shell is not actually root, so grant it root-equivalent read access temporarily.
          await chmodLink(fixture.commandPath, '755')
          try {
            await executePrivilegedShell(command)
          } catch (error) {
            await chmodLink(fixture.commandPath, '000').catch(() => undefined)
            throw error
          }
        }
      })
      const { launcherPath } = await installer.getStatus()
      if (!launcherPath) {
        throw new Error('The fixture launcher was not created.')
      }
      const foreignPath = join(fixture.root, 'foreign')
      await writeFile(foreignPath, '#!/bin/sh\n')
      const linkTarget =
        target === 'launcher'
          ? launcherPath
          : target === 'foreign'
            ? foreignPath
            : join(fixture.root, 'missing')
      await symlink(linkTarget, fixture.commandPath)
      await chmodLink(fixture.commandPath, '000')
      await expect(readlink(fixture.commandPath)).rejects.toMatchObject({ code: 'EACCES' })
      return { fixture, installer, commands, linkTarget }
    }

    it('builds a transaction that publishes a readable link under any umask', () => {
      const command = buildMacPrivilegedSymlinkTransaction({
        action: 'install',
        commandPath: '/usr/local/bin/orca',
        launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
        expected: null,
        expectedFileSha256: null,
        expectedRawSymlinkTarget: null
      })
      expect(command.startsWith('umask 077;')).toBe(true)
      expect(command).toMatch(/\/bin\/chmod -h 755 '[^']*\/publish\/orca'/)
    })

    it('publishes a world-readable link when root has a hardened umask', async () => {
      const fixture = await createPrivilegedFixture()
      const installer = new CliInstaller({
        ...fixtureInstallerOptions(fixture),
        privilegedRunner: async (command) => {
          await chmod(fixture.protectedDirectory, 0o700)
          await executePrivilegedShell(`umask 077; ${command}`)
        }
      })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      expect(await linkMode(fixture.commandPath)).toBe(0o755)
    })

    it('reports an unreadable link to this launcher as stale', async () => {
      const { fixture, installer } = await createUnreadableLinkFixture('launcher')

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: null,
        detail: `Orca can't read ${fixture.commandPath} (permission denied). Register again to repair it.`
      })
    })

    it.each(['foreign', 'dangling'] as const)(
      'reports an unreadable %s link as a conflict',
      async (target) => {
        const { installer } = await createUnreadableLinkFixture(target)

        const status = await installer.getStatus()
        expect(status).toMatchObject({ state: 'conflict', currentTarget: null })
        expect(status.detail).toContain('Repair its permissions and refresh')
      }
    )

    it('repairs and removes an unreadable link through one privileged transaction each', async () => {
      const { fixture, installer, commands } = await createUnreadableLinkFixture('launcher')

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      expect(commands).toHaveLength(1)
      expect(await linkMode(fixture.commandPath)).toBe(0o755)

      await chmodLink(fixture.commandPath, '000')
      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
      expect(commands).toHaveLength(2)
      await expect(lstat(fixture.commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('uses privileged verification for an unreadable link in a user-writable folder', async () => {
      const { fixture, installer, commands } = await createUnreadableLinkFixture('launcher')

      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      expect(commands).toHaveLength(1)
      expect(await linkMode(fixture.commandPath)).toBe(0o755)
    })

    it('refuses an unreadable indirect link to the launcher', async () => {
      const { fixture, installer, commands, linkTarget } =
        await createUnreadableLinkFixture('launcher')
      const aliasPath = join(fixture.root, 'launcher-alias')
      await chmodLink(fixture.commandPath, '755')
      await unlink(fixture.commandPath)
      await symlink(linkTarget, aliasPath)
      await symlink(aliasPath, fixture.commandPath)
      await chmodLink(fixture.commandPath, '000')

      await expect(installer.install()).rejects.toThrow()
      expect(commands).toHaveLength(1)
      await chmodLink(fixture.commandPath, '755')
      await expect(readlink(fixture.commandPath)).resolves.toBe(aliasPath)
    })

    it('refuses to replace an unreadable link it cannot prove is Orca', async () => {
      const { fixture, installer, commands, linkTarget } =
        await createUnreadableLinkFixture('foreign')
      const before = await lstat(fixture.commandPath, { bigint: true })

      await chmod(fixture.protectedDirectory, 0o500)
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
      expect(commands).toHaveLength(0)
      const after = await lstat(fixture.commandPath, { bigint: true })
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
      await chmodLink(fixture.commandPath, '755')
      await expect(readlink(fixture.commandPath)).resolves.toBe(linkTarget)
    })

    it('keeps the identity snapshot when the evidence readlink is denied', async () => {
      const { fixture } = await createUnreadableLinkFixture('launcher')
      const status: CliInstallStatus = {
        platform: 'darwin',
        commandName: 'orca',
        commandPath: fixture.commandPath,
        pathDirectory: fixture.protectedDirectory,
        pathConfigured: true,
        launcherPath: null,
        installMethod: 'symlink',
        supported: true,
        state: 'stale',
        currentTarget: null,
        unsupportedReason: null,
        detail: null
      }

      const inspected = await inspectStableCommand(fixture.commandPath, async () => status)
      const expected = await lstat(fixture.commandPath, { bigint: true })
      expect(inspected.rawSymlinkTarget).toBeNull()
      expect(inspected.snapshot).toMatchObject({
        isSymbolicLink: true,
        identity: { dev: expected.dev, ino: expected.ino }
      })
    })
  }
)
