import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
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

import { CliInstaller } from '../cli-installer'

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

describe.skipIf(process.platform === 'win32')('CLI command filesystem races', () => {
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
})
