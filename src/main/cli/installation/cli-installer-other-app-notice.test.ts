import { existsSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

// While `failing` is set, realpath throws, as when the target goes away after the check.
const realpathControl = vi.hoisted(() => ({ failing: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const realpath = async (path: string): Promise<string> => {
    if (realpathControl.failing) {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    }
    return actual.realpath(path)
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})

import { CliInstaller } from '../cli-installer'
import { otherMacAppBundle } from './cli-command-inspection'

const roots: string[] = []

afterEach(async () => {
  realpathControl.failing = false
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-other-app-'))
  roots.push(root)
  return root
}

function launcherIn(appBundle: string): { resourcesPath: string; launcher: string } {
  const resourcesPath = join(appBundle, 'Contents', 'Resources')
  return { resourcesPath, launcher: join(resourcesPath, 'bin', 'orca') }
}

async function writeLauncher(
  appBundle: string
): Promise<{ resourcesPath: string; launcher: string }> {
  const paths = launcherIn(appBundle)
  await mkdir(join(paths.resourcesPath, 'bin'), { recursive: true })
  await writeFile(paths.launcher, '#!/usr/bin/env bash\necho orca\n', {
    encoding: 'utf8',
    mode: 0o755
  })
  return paths
}

/** An installer for the app in `ours`, with `orca` on the PATH linked to `target`. */
async function installerLinkedTo(
  root: string,
  target: string,
  ours: { resourcesPath: string }
): Promise<{ installer: CliInstaller; commandPath: string }> {
  const bin = join(root, 'usr', 'local', 'bin')
  await mkdir(bin, { recursive: true })
  const commandPath = join(bin, 'orca')
  await symlink(target, commandPath)
  const installer = new CliInstaller({
    platform: 'darwin',
    isPackaged: true,
    resourcesPath: ours.resourcesPath,
    userDataPath: join(root, 'userData'),
    execPath: join(root, 'Orca Beta.app', 'Contents', 'MacOS', 'Orca'),
    appPath: join(root, 'app'),
    homePath: join(root, 'home'),
    defaultMacCommandPath: commandPath,
    processPathEnv: bin
  })
  return { installer, commandPath }
}

// Two Orca apps can own `orca`. Register says when it takes the link from the other app.
describe('CLI link owned by another Orca app', () => {
  it('finds the other .app bundle only when it exists and differs from ours', async () => {
    const root = await tempRoot()
    const otherApp = join(root, 'Orca.app')
    const other = await writeLauncher(otherApp)
    const ours = await writeLauncher(join(root, 'Orca Beta.app'))
    const plainFile = join(root, 'bin', 'orca')
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(plainFile, '', 'utf8')

    expect(await otherMacAppBundle(other.launcher, ours.launcher)).toBe(otherApp)
    expect(await otherMacAppBundle(ours.launcher, ours.launcher)).toBeNull()
    expect(await otherMacAppBundle(plainFile, ours.launcher)).toBeNull()
    expect(
      await otherMacAppBundle(launcherIn(join(root, 'Gone', 'Orca.app')).launcher, ours.launcher)
    ).toBeNull()
    expect(await otherMacAppBundle(null, ours.launcher)).toBeNull()
    // The bundle exists, but it has no launcher.
    const emptyApp = join(root, 'Empty.app')
    await mkdir(emptyApp, { recursive: true })
    expect(await otherMacAppBundle(launcherIn(emptyApp).launcher, ours.launcher)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'warns before it replaces the link, and says what it replaced after',
    async () => {
      const root = await tempRoot()
      const otherApp = join(root, 'Orca.app')
      const other = await writeLauncher(otherApp)
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, other.launcher, ours)

      const before = await installer.getStatus()
      expect(before.state).toBe('stale')
      expect(before.detail).toBe(
        `${commandPath} belongs to another Orca app (${otherApp}). Register replaces it. To switch back, register the CLI again in that app.`
      )

      const after = await installer.install()
      expect(after.state).toBe('installed')
      expect(await readlink(commandPath)).toBe(ours.launcher)
      expect(after.detail).toBe(
        `Replaced the ${commandPath} link to ${otherApp}. To switch back, register the CLI again in that app.`
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'treats a link into a missing app as an older launcher, before and after Register',
    async () => {
      const root = await tempRoot()
      const gone = launcherIn(join(root, 'Gone', 'Orca.app')).launcher
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, gone, ours)

      const before = await installer.getStatus()
      expect(before.state).toBe('stale')
      expect(before.detail).toBe(`${commandPath} points to an older Orca launcher.`)

      const after = await installer.install()
      expect(after.state).toBe('installed')
      expect(after.detail).toBe(`Registered at ${commandPath}.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the older-launcher text for a stale link into our own bundle',
    async () => {
      const root = await tempRoot()
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      // The same launcher through another path: the link is stale, but the bundle is ours.
      await symlink(root, join(root, 'alias'))
      const alias = launcherIn(join(root, 'alias', 'Orca Beta.app')).launcher
      const { installer, commandPath } = await installerLinkedTo(root, alias, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('stale')
      expect(status.detail).toBe(`${commandPath} points to an older Orca launcher.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the non-Orca text for a link to a file outside any .app',
    async () => {
      const root = await tempRoot()
      const plainFile = join(root, 'tools', 'orca')
      await mkdir(join(root, 'tools'), { recursive: true })
      await writeFile(plainFile, '', 'utf8')
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, plainFile, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('conflict')
      expect(status.detail).toBe(`${commandPath} points to a non-Orca launcher.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'says nothing about the other app when Register does not reach installed',
    async () => {
      const root = await tempRoot()
      const other = await writeLauncher(join(root, 'Orca.app'))
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, other.launcher, ours)
      // The status after the link change reads stale.
      const realGetStatus = installer.getStatus.bind(installer)
      let calls = 0
      vi.spyOn(installer, 'getStatus').mockImplementation(async () => {
        const status = await realGetStatus()
        calls += 1
        return calls === 1 ? status : { ...status, state: 'stale' }
      })

      const after = await installer.install()
      expect(after.state).toBe('stale')
      expect(after.detail).toBe(`Registered at ${commandPath}.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the non-Orca text for a link to a non-Orca tool inside another .app',
    async () => {
      const root = await tempRoot()
      const tool = join(root, 'Tool.app', 'Contents', 'Resources', 'bin', 'tool')
      await mkdir(join(root, 'Tool.app', 'Contents', 'Resources', 'bin'), { recursive: true })
      await writeFile(tool, '', 'utf8')
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, tool, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('conflict')
      expect(status.detail).toBe(`${commandPath} points to a non-Orca launcher.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the older-launcher text for our own bundle in another letter case',
    async (context) => {
      const root = await tempRoot()
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const otherCase = launcherIn(join(root, 'orca beta.app')).launcher
      // Only a case-insensitive disk finds the bundle under the other letter case.
      if (!existsSync(otherCase)) {
        context.skip()
      }
      const { installer, commandPath } = await installerLinkedTo(root, otherCase, ours)

      expect(await otherMacAppBundle(otherCase, ours.launcher)).toBeNull()
      const status = await installer.getStatus()
      expect(status.state).toBe('stale')
      expect(status.detail).toBe(`${commandPath} points to an older Orca launcher.`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'names no other app when realpath fails, and Register still resolves',
    async () => {
      const root = await tempRoot()
      const other = await writeLauncher(join(root, 'Orca.app'))
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, other.launcher, ours)

      realpathControl.failing = true
      expect(await otherMacAppBundle(other.launcher, ours.launcher)).toBeNull()
      const after = await installer.install()
      realpathControl.failing = false
      expect(after.state).toBe('installed')
      expect(after.detail).toBe(`Registered at ${commandPath}.`)
      expect(await readlink(commandPath)).toBe(ours.launcher)
    }
  )
})
