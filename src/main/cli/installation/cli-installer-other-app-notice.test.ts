import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

import { CliInstaller } from '../cli-installer'
import { otherMacAppBundle } from './cli-command-inspection'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-other-app-'))
  roots.push(root)
  return root
}

function launcherIn(appBundle: string): {
  resourcesPath: string
  launcher: string
} {
  const resourcesPath = join(appBundle, 'Contents', 'Resources')
  return { resourcesPath, launcher: join(resourcesPath, 'bin', 'orca') }
}

async function writeLauncher(
  appBundle: string,
  bundleId = 'com.stablyai.orca'
): Promise<{ resourcesPath: string; launcher: string }> {
  const paths = launcherIn(appBundle)
  await mkdir(join(paths.resourcesPath, 'bin'), { recursive: true })
  await writeFile(
    join(appBundle, 'Contents', 'Info.plist'),
    `<plist><dict>\n<key>CFBundleIdentifier</key>\n<string>${bundleId}</string>\n</dict></plist>`,
    'utf8'
  )
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

// Two Orca apps can own `orca`. The status says when the link belongs to the other app.
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
    // The bundle identifier decides, not the bundle name.
    const renamedApp = join(root, 'Renamed.app')
    const renamed = await writeLauncher(renamedApp)
    expect(await otherMacAppBundle(renamed.launcher, ours.launcher)).toBe(renamedApp)
    const tool = await writeLauncher(join(root, 'Tool.app'), 'com.example.tool')
    expect(await otherMacAppBundle(tool.launcher, ours.launcher)).toBeNull()
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
    'warns before it replaces the link of another Orca app',
    async () => {
      const root = await tempRoot()
      const otherApp = join(root, 'Orca.app')
      const other = await writeLauncher(otherApp)
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, other.launcher, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('stale')
      expect(status.detail).toBe(
        `${commandPath} belongs to another Orca app (${otherApp}). Register replaces it. To switch back, register the CLI again in that app.`
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'treats a link into a missing app as an older launcher',
    async () => {
      const root = await tempRoot()
      const gone = launcherIn(join(root, 'Gone', 'Orca.app')).launcher
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, gone, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('stale')
      expect(status.detail).toBe(`${commandPath} points to an older Orca launcher.`)
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
    'keeps the older-launcher text for a non-Orca bundle whose launcher is named orca',
    async () => {
      const root = await tempRoot()
      const tool = await writeLauncher(join(root, 'Tool.app'), 'com.example.tool')
      const ours = await writeLauncher(join(root, 'Orca Beta.app'))
      const { installer, commandPath } = await installerLinkedTo(root, tool.launcher, ours)

      const status = await installer.getStatus()
      expect(status.state).toBe('stale')
      expect(status.detail).toBe(`${commandPath} points to an older Orca launcher.`)
    }
  )
})
