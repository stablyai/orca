import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { inspectStableCommand } from './cli-command-filesystem-transaction'
import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

// Why simulated rather than staged: macOS enforces a symlink's own permission bits on readlink(2),
// so the real failure needs a root-owned 0700 link — which a test cannot create without root, and
// which a non-root owner can always read anyway. Injecting the denial is the only faithful way in.
const deniedPaths = vi.hoisted(() => ({ readlink: '', readFile: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const deny = (path: string, operation: string): never => {
    throw Object.assign(new Error(`EACCES: permission denied, ${operation} '${path}'`), {
      code: 'EACCES'
    })
  }
  return {
    ...actual,
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      if (args[0] === deniedPaths.readlink) {
        deny(String(args[0]), 'readlink')
      }
      return actual.readlink(...args)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === deniedPaths.readFile) {
        deny(String(args[0]), 'open')
      }
      return actual.readFile(...args)
    }
  }
})

const pendingCleanup: string[] = []

afterEach(async () => {
  deniedPaths.readlink = ''
  deniedPaths.readFile = ''
  await Promise.all(
    pendingCleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function buildStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: '/Applications/Orca.app/Contents/Resources/bin/orca',
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

// Why: Windows may refuse file-symlink creation without Developer Mode or elevation.
describe.skipIf(process.platform === 'win32')('an entry that cannot be read', () => {
  async function makeMacInstaller(entry: 'symlink' | 'file'): Promise<{
    installer: CliInstaller
    commandPath: string
  }> {
    const fixture = await makeFixture()
    pendingCleanup.push(fixture.root)
    const homePath = join(fixture.root, 'home')
    const resourcesPath = await createPackagedMacLauncher(fixture.root)

    // The dir exists, so this is the canonical macOS command path the installer inspects.
    const binDirectory = join(fixture.root, 'usr', 'local', 'bin')
    await mkdir(binDirectory, { recursive: true })
    const commandPath = join(binDirectory, 'orca')
    await (entry === 'symlink'
      ? symlink(join(resourcesPath, 'bin', 'orca'), commandPath)
      : writeFile(commandPath, '#!/bin/sh\n', 'utf8'))

    return {
      commandPath,
      installer: new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: commandPath,
        processPathEnv: join(homePath, '.local', 'bin')
      })
    }
  }

  it('reports an unreadable symlink as stale instead of failing the whole call', async () => {
    const { installer, commandPath } = await makeMacInstaller('symlink')
    deniedPaths.readlink = commandPath

    const status = await installer.getStatus()

    expect(status.commandPath).toBe(commandPath)
    expect(status.state).toBe('stale')
    // No target evidence is available, so nothing may claim which launcher it points at.
    expect(status.currentTarget).toBeNull()
    expect(status.detail).toContain('cannot be read')
  })

  it('does not recover an unreadable regular file as a stale symlink', async () => {
    const { installer, commandPath } = await makeMacInstaller('file')
    deniedPaths.readFile = commandPath

    // A regular file Orca cannot read is not an older launcher of its own, so this must keep failing
    // rather than inviting a replacement of a file whose contents were never inspected.
    await expect(installer.getStatus()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('resolves a stable inspection with no target evidence instead of retrying to failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-unreadable-symlink-'))
    pendingCleanup.push(root)
    const commandPath = join(root, 'orca')
    await symlink('/some/other/target', commandPath)
    deniedPaths.readlink = commandPath

    const status = buildStatus({ state: 'stale', currentTarget: null })
    const inspection = await inspectStableCommand(commandPath, async () => status)

    expect(inspection.status).toBe(status)
    expect(inspection.rawSymlinkTarget).toBeNull()
    expect(inspection.fileSha256).toBeNull()
  })
})
