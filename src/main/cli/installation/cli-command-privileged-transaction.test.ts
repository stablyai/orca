import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

import { CliInstaller } from '../cli-installer'
import { buildUnixCliLauncher } from '../launchers/cli-dev-launcher'

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
  }
)
