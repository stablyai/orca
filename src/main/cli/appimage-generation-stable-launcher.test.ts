import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureAppImageStableLauncher,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))

import { CliInstaller } from './cli-installer'
import { installLinuxBareOrcaDispatcher } from './linux-bare-orca-dispatcher'

const created: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A server run through the stable launcher runs from one extracted generation, with no $APPIMAGE. */
async function makeGeneration() {
  const root = await mkdtemp(join(tmpdir(), 'orca-generation-launcher-'))
  created.push(root)
  const cacheRootPath = join(root, 'cache', 'orca', 'appimage')
  const generationRoot = join(cacheRootPath, 'a'.repeat(24), 'b'.repeat(24))
  const resourcesPath = join(generationRoot, 'resources')
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', { mode: 0o755 })
  await writeFile(join(generationRoot, 'orca-ide'), '', { mode: 0o755 })
  expect(ensureAppImageStableLauncher(cacheRootPath)).toBe(
    resolveAppImageStableLauncherPath(cacheRootPath)
  )
  vi.stubEnv('APPIMAGE', '')
  vi.stubEnv('APPDIR', '')
  return {
    homePath: join(root, 'home'),
    resourcesPath,
    generationRoot,
    stableLauncherPath: resolveAppImageStableLauncherPath(cacheRootPath)
  }
}

describe.skipIf(process.platform === 'win32')(
  'CLI registration from an extracted generation',
  () => {
    it('points bare `orca` at the stable launcher, never at a generation a later prune deletes', async () => {
      const fixture = await makeGeneration()
      const result = await installLinuxBareOrcaDispatcher({
        resourcesPath: fixture.resourcesPath,
        homePath: fixture.homePath
      })
      expect(result).toMatchObject({ state: 'installed', target: fixture.stableLauncherPath })
    })

    it('recognises the stable launcher it registered as its own `orca-ide`', async () => {
      const fixture = await makeGeneration()
      const commandDirectory = join(fixture.homePath, '.local', 'bin')
      await mkdir(commandDirectory, { recursive: true })
      await symlink(fixture.stableLauncherPath, join(commandDirectory, 'orca-ide'))
      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: true,
        userDataPath: join(fixture.homePath, 'user-data'),
        resourcesPath: fixture.resourcesPath,
        execPath: join(fixture.generationRoot, 'orca-ide'),
        appPath: join(fixture.resourcesPath, 'app.asar'),
        homePath: fixture.homePath,
        processPathEnv: commandDirectory
      })
      const status = await installer.install()
      expect(status.state).toBe('installed')
      expect(status.commandPath).toBe(join(commandDirectory, 'orca-ide'))
    })
  }
)
