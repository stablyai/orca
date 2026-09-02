import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const legacyReadlinkRace = vi.hoisted(() => ({ commandPath: '', replacementTarget: '' }))
const reusedIdentity = vi.hoisted(() => ({
  path: '',
  dev: null as bigint | null,
  ino: null as bigint | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args)
      if (
        args[0] !== reusedIdentity.path ||
        reusedIdentity.dev === null ||
        reusedIdentity.ino === null
      ) {
        return stats
      }
      return Object.create(stats, {
        dev: { value: reusedIdentity.dev },
        ino: { value: reusedIdentity.ino }
      }) as typeof stats
    },
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      const [path] = args
      if (path === legacyReadlinkRace.commandPath && legacyReadlinkRace.replacementTarget) {
        const replacementTarget = legacyReadlinkRace.replacementTarget
        legacyReadlinkRace.commandPath = ''
        legacyReadlinkRace.replacementTarget = ''
        await actual.unlink(path)
        await actual.symlink(replacementTarget, path)
        throw Object.assign(new Error('link vanished during inspection'), { code: 'ENOENT' })
      }
      return actual.readlink(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'
import type { CommandQuarantine } from './cli-command-filesystem-transaction'

const createdRoots: string[] = []

afterEach(async () => {
  legacyReadlinkRace.commandPath = ''
  legacyReadlinkRace.replacementTarget = ''
  reusedIdentity.path = ''
  reusedIdentity.dev = null
  reusedIdentity.ino = null
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function createMacCommandFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-command-race-'))
  createdRoots.push(root)
  const commandDirectory = join(root, 'bin')
  const commandPath = join(commandDirectory, 'orca')
  const resourcesPath = join(root, 'Current.app', 'Contents', 'Resources')
  const launcherPath = join(resourcesPath, 'bin', 'orca')
  const staleLauncherPath = join(root, 'Old.app', 'Contents', 'Resources', 'bin', 'orca')
  await mkdir(commandDirectory, { recursive: true })
  await mkdir(dirname(launcherPath), { recursive: true })
  await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  return { root, commandDirectory, commandPath, resourcesPath, launcherPath, staleLauncherPath }
}

function createMacInstaller(
  fixture: Awaited<ReturnType<typeof createMacCommandFixture>>,
  hooks: {
    quarantine?: (commandPath: string) => Promise<void>
    afterQuarantine?: (quarantine: CommandQuarantine) => void
    link?: (heldPath: string, commandPath: string) => Promise<void>
  } = {}
): CliInstaller {
  class RaceInjectedInstaller extends CliInstaller {
    protected override async quarantineCommandPath(commandPath: string) {
      await hooks.quarantine?.(commandPath)
      const quarantine = await super.quarantineCommandPath(commandPath)
      hooks.afterQuarantine?.(quarantine)
      return quarantine
    }

    protected override async linkQuarantinedCommand(
      heldPath: string,
      commandPath: string
    ): Promise<void> {
      await hooks.link?.(heldPath, commandPath)
      return super.linkQuarantinedCommand(heldPath, commandPath)
    }
  }

  return new RaceInjectedInstaller({
    platform: 'darwin',
    isPackaged: true,
    userDataPath: join(fixture.root, 'user-data'),
    resourcesPath: fixture.resourcesPath,
    execPath: join(fixture.root, 'Current.app', 'Contents', 'MacOS', 'Orca'),
    appPath: join(fixture.root, 'Current.app', 'Contents', 'Resources', 'app.asar'),
    homePath: join(fixture.root, 'home'),
    commandPathOverride: fixture.commandPath,
    processPathEnv: fixture.commandDirectory
  })
}

async function recoveryPath(commandDirectory: string): Promise<string> {
  const transactionName = (await readdir(commandDirectory)).find((name) =>
    name.startsWith('.orca-cli-')
  )
  if (!transactionName) {
    throw new Error('Expected a preserved CLI command transaction.')
  }
  return join(commandDirectory, transactionName, 'orca')
}

async function rejectionFrom(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }
  throw new Error('Expected the operation to reject.')
}

describe.skipIf(process.platform === 'win32')('CLI command filesystem races', () => {
  it('replaces and removes an unchanged stale symlink through the real filesystem', async () => {
    const fixture = await createMacCommandFixture()
    await symlink(fixture.staleLauncherPath, fixture.commandPath)
    const installer = createMacInstaller(fixture)

    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    await expect(readlink(fixture.commandPath)).resolves.toBe(fixture.launcherPath)
    await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
    await expect(lstat(fixture.commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores a foreign symlink whose quarantined inode identity is reused', async () => {
    const fixture = await createMacCommandFixture()
    const foreignTarget = join(fixture.root, 'foreign-command')
    await symlink(fixture.staleLauncherPath, fixture.commandPath)
    const original = await lstat(fixture.commandPath, { bigint: true })
    let raced = false
    const installer = createMacInstaller(fixture, {
      quarantine: async (commandPath) => {
        if (raced) {
          return
        }
        raced = true
        await unlink(commandPath)
        await symlink(foreignTarget, commandPath)
      },
      afterQuarantine: (quarantine) => {
        if (quarantine.snapshot) {
          reusedIdentity.path = quarantine.heldPath
          reusedIdentity.dev = original.dev
          reusedIdentity.ino = original.ino
          quarantine.snapshot.identity = {
            ...quarantine.snapshot.identity,
            dev: original.dev,
            ino: original.ino
          }
        }
      }
    })

    await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
    await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
    expect(
      (await readdir(fixture.commandDirectory)).some((name) => name.startsWith('.orca-cli-'))
    ).toBe(false)
  })

  it('preserves a managed file changed in place after its final inspection', async () => {
    const fixture = await createMacCommandFixture()
    const oldCliPath = join(fixture.root, 'old', 'out', 'cli', 'index.js')
    await writeFile(
      fixture.commandPath,
      [
        '#!/usr/bin/env bash',
        `CLI='${oldCliPath}'`,
        'export ORCA_NODE_OPTIONS="${NODE_OPTIONS-}"',
        'export ORCA_NODE_REPL_EXTERNAL_MODULE="${NODE_REPL_EXTERNAL_MODULE-}"',
        'ELECTRON_RUN_AS_NODE=1 exec electron "$CLI" "$@"'
      ].join('\n')
    )
    let raced = false
    const installer = createMacInstaller(fixture, {
      quarantine: async (commandPath) => {
        if (raced) {
          return
        }
        raced = true
        await writeFile(commandPath, 'foreign command written into the inspected inode')
      }
    })

    await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
    await expect(readFile(fixture.commandPath, 'utf8')).resolves.toBe(
      'foreign command written into the inspected inode'
    )
  })

  it('restores a foreign symlink raced into command removal', async () => {
    const fixture = await createMacCommandFixture()
    const foreignTarget = join(fixture.root, 'foreign-command')
    await symlink(fixture.launcherPath, fixture.commandPath)
    let raced = false
    const installer = createMacInstaller(fixture, {
      quarantine: async (commandPath) => {
        if (raced) {
          return
        }
        raced = true
        await unlink(commandPath)
        await symlink(foreignTarget, commandPath)
      }
    })

    await expect(installer.remove()).rejects.toThrow('Refusing to remove non-Orca command')
    await expect(readlink(fixture.commandPath)).resolves.toBe(foreignTarget)
  })

  it('preserves a raced foreign directory at the reported recovery path', async () => {
    const fixture = await createMacCommandFixture()
    await symlink(fixture.staleLauncherPath, fixture.commandPath)
    let raced = false
    const installer = createMacInstaller(fixture, {
      quarantine: async (commandPath) => {
        if (raced) {
          return
        }
        raced = true
        await unlink(commandPath)
        await mkdir(commandPath)
        await writeFile(join(commandPath, 'user-data'), 'preserved')
      }
    })

    const error = await rejectionFrom(installer.install())
    const heldPath = await recoveryPath(fixture.commandDirectory)
    expect(error.message).toContain(heldPath)
    await expect(readFile(join(heldPath, 'user-data'), 'utf8')).resolves.toBe('preserved')
    await expect(lstat(fixture.commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves both entries when the original name is reclaimed during restoration', async () => {
    const fixture = await createMacCommandFixture()
    const contenderTarget = join(fixture.root, 'contender-command')
    await symlink(fixture.staleLauncherPath, fixture.commandPath)
    let raced = false
    const installer = createMacInstaller(fixture, {
      quarantine: async (commandPath) => {
        if (raced) {
          return
        }
        raced = true
        await unlink(commandPath)
        await writeFile(commandPath, 'foreign command')
      },
      link: async (_heldPath, commandPath) => {
        await symlink(contenderTarget, commandPath)
      }
    })

    const error = await rejectionFrom(installer.install())
    const heldPath = await recoveryPath(fixture.commandDirectory)
    expect(error.message).toContain(heldPath)
    await expect(readFile(heldPath, 'utf8')).resolves.toBe('foreign command')
    await expect(readlink(fixture.commandPath)).resolves.toBe(contenderTarget)
  })

  it('keeps a foreign legacy Linux command when readlink loses the inspection race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cli-legacy-race-'))
    createdRoots.push(root)
    const homePath = join(root, 'home')
    const commandDirectory = join(homePath, '.local', 'bin')
    const resourcesPath = join(root, 'resources')
    const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
    const legacyPath = join(commandDirectory, 'orca')
    const managedLegacyTarget = join(resourcesPath, 'bin', 'orca')
    const foreignTarget = join(root, 'foreign-orca')
    await mkdir(commandDirectory, { recursive: true })
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    await symlink(managedLegacyTarget, legacyPath)

    legacyReadlinkRace.commandPath = legacyPath
    legacyReadlinkRace.replacementTarget = foreignTarget
    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: join(root, 'user-data'),
      resourcesPath,
      execPath: join(root, 'orca-ide'),
      appPath: join(root, 'resources', 'app.asar'),
      homePath,
      processPathEnv: commandDirectory
    })

    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    await expect(readlink(legacyPath)).resolves.toBe(foreignTarget)
  })

  it('keeps a foreign legacy Linux command whose quarantined inode is reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cli-legacy-identity-race-'))
    createdRoots.push(root)
    const homePath = join(root, 'home')
    const commandDirectory = join(homePath, '.local', 'bin')
    const resourcesPath = join(root, 'resources')
    const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
    const legacyPath = join(commandDirectory, 'orca')
    const managedTarget = join(resourcesPath, 'bin', 'orca')
    const foreignTarget = join(root, 'foreign-orca')
    await mkdir(commandDirectory, { recursive: true })
    await mkdir(dirname(launcherPath), { recursive: true })
    await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    await symlink(managedTarget, legacyPath)
    const original = await lstat(legacyPath, { bigint: true })

    class LegacyRaceInstaller extends CliInstaller {
      protected override async quarantineCommandPath(commandPath: string) {
        if (commandPath === legacyPath) {
          await unlink(commandPath)
          await symlink(foreignTarget, commandPath)
        }
        const quarantine = await super.quarantineCommandPath(commandPath)
        if (commandPath === legacyPath && quarantine.snapshot) {
          reusedIdentity.path = quarantine.heldPath
          reusedIdentity.dev = original.dev
          reusedIdentity.ino = original.ino
          quarantine.snapshot.identity = {
            ...quarantine.snapshot.identity,
            dev: original.dev,
            ino: original.ino
          }
        }
        return quarantine
      }
    }

    const installer = new LegacyRaceInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: join(root, 'user-data'),
      resourcesPath,
      execPath: join(root, 'orca-ide'),
      appPath: join(root, 'resources', 'app.asar'),
      homePath,
      processPathEnv: commandDirectory
    })

    await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
    await expect(readlink(legacyPath)).resolves.toBe(foreignTarget)
  })
})
