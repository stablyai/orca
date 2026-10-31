import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

const roots: string[] = []
const unreadableContents = '#!/bin/sh\nexit 0\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createUnreadableCommandFixture() {
  const fixture = await makeFixture()
  roots.push(fixture.root)
  const resourcesPath = await createPackagedMacLauncher(fixture.root)
  await copyFile(join(resourcesPath, 'bin', 'orca'), join(resourcesPath, 'bin', 'orca-ide'))
  const defaultBin = join(fixture.root, 'default', 'bin')
  const foreignBin = join(fixture.root, 'foreign', 'bin')
  await mkdir(defaultBin, { recursive: true })
  await mkdir(foreignBin, { recursive: true })
  const commandPath = join(defaultBin, 'orca')
  const foreignPath = join(foreignBin, 'orca')
  await symlink(join(resourcesPath, 'bin', 'orca'), commandPath)
  await writeFile(foreignPath, unreadableContents, { mode: 0o111 })
  return { ...fixture, resourcesPath, defaultBin, foreignBin, commandPath, foreignPath }
}

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'unreadable CLI commands',
  () => {
    it('reports an unreadable executable before the installed launcher as a conflict', async () => {
      const fixture = await createUnreadableCommandFixture()
      const installer = new CliInstaller({
        ...fixture,
        platform: 'darwin',
        isPackaged: true,
        execPath: join(fixture.root, 'Orca'),
        homePath: join(fixture.root, 'home'),
        defaultMacCommandPath: fixture.commandPath,
        processPathEnv: `${fixture.foreignBin}:${fixture.defaultBin}`
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        commandPath: fixture.foreignPath,
        currentTarget: null,
        pathConfigured: true
      })
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
      await chmod(fixture.foreignPath, 0o600)
      expect(await readFile(fixture.foreignPath, 'utf8')).toBe(unreadableContents)
    })
  }
)
