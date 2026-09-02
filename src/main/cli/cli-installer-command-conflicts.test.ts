import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

describe('CliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Why: this test creates a Unix symlink to /tmp/not-orca, which only applies on macOS/Linux.
  it.skipIf(process.platform === 'win32')(
    'refuses to replace an unknown symlink at the command path',
    async () => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, 'bin', 'orca')
      const existingTarget = '/tmp/not-orca'
      await mkdir(join(fixture.root, 'bin'), { recursive: true })
      await symlink(existingTarget, installPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        appPath: fixture.appPath,
        commandPathOverride: installPath
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        supported: true
      })
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
      await expect(readlink(installPath)).resolves.toBe(existingTarget)
    }
  )

  // Why: packaged app moves can leave a symlink to an older Orca-owned launcher;
  // those are safe to refresh, unlike arbitrary user symlinks.
  it.skipIf(process.platform === 'win32')(
    'replaces stale packaged Orca launcher symlinks',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, 'bin')
      const installPath = join(commandDir, 'orca')
      const resourcesPath = join(fixture.root, 'Current.app', 'Contents', 'Resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca')
      const oldLauncherPath = join(fixture.root, 'Old.app', 'Contents', 'Resources', 'bin', 'orca')
      await mkdir(commandDir, { recursive: true })
      await mkdir(join(resourcesPath, 'bin'), { recursive: true })
      await writeFile(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
      await symlink(oldLauncherPath, installPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: oldLauncherPath
      })
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readlink(installPath)).resolves.toBe(launcherPath)
    }
  )

  // Why: old dev/package experiments wrote a generated Orca launcher file
  // directly into /usr/local/bin/orca. That broke profiling because Settings
  // treated the regular file as a hard conflict and would not self-heal it.
  it.skipIf(process.platform === 'win32')(
    'replaces stale generated Unix launcher files',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, 'bin')
      const installPath = join(commandDir, 'orca')
      const resourcesPath = join(fixture.root, 'Current.app', 'Contents', 'Resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca')
      const oldCliPath = join(fixture.root, 'OldWorktree', 'out', 'cli', 'index.js')
      await mkdir(commandDir, { recursive: true })
      await mkdir(join(resourcesPath, 'bin'), { recursive: true })
      await writeFile(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
      await writeFile(
        installPath,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          "ELECTRON='/tmp/Old.app/Contents/MacOS/Electron'",
          `CLI='${oldCliPath}'`,
          'export ORCA_NODE_OPTIONS="${NODE_OPTIONS-}"',
          'export ORCA_NODE_REPL_EXTERNAL_MODULE="${NODE_REPL_EXTERNAL_MODULE-}"',
          'unset NODE_OPTIONS',
          'unset NODE_REPL_EXTERNAL_MODULE',
          'ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"',
          ''
        ].join('\n'),
        'utf8'
      )

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: oldCliPath
      })
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readlink(installPath)).resolves.toBe(launcherPath)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps arbitrary regular files at the command path as conflicts',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, 'bin')
      const installPath = join(commandDir, 'orca')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      await mkdir(commandDir, { recursive: true })
      await writeFile(
        installPath,
        '#!/usr/bin/env bash\nELECTRON_RUN_AS_NODE=1 /tmp/not-orca "$@"\n',
        'utf8'
      )

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        currentTarget: null
      })
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-Orca command')
      await expect(readFile(installPath, 'utf8')).resolves.toContain('/tmp/not-orca')
    }
  )

  // Why: a dev build can temporarily own the public command on developer
  // machines; packaged Orca should treat that as stale, not a hard conflict.
  it.skipIf(process.platform === 'win32')(
    'replaces stale sibling dev launcher symlinks from packaged installs',
    async () => {
      const fixture = await makeFixture()
      for (const devLauncherName of ['orca', 'orca-dev']) {
        const caseRoot = join(fixture.root, devLauncherName)
        const commandDir = join(caseRoot, 'bin')
        const installPath = join(commandDir, 'orca')
        const userDataPath = join(caseRoot, 'orca')
        const resourcesPath = join(caseRoot, 'Current.app', 'Contents', 'Resources')
        const launcherPath = join(resourcesPath, 'bin', 'orca')
        const devLauncherPath = join(`${userDataPath}-dev`, 'cli', 'bin', devLauncherName)
        await mkdir(commandDir, { recursive: true })
        await mkdir(join(resourcesPath, 'bin'), { recursive: true })
        await mkdir(join(`${userDataPath}-dev`, 'cli', 'bin'), { recursive: true })
        await writeFile(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
        await writeFile(devLauncherPath, '#!/usr/bin/env bash\n', 'utf8')
        await symlink(devLauncherPath, installPath)

        const installer = new CliInstaller({
          platform: 'darwin',
          isPackaged: true,
          userDataPath,
          resourcesPath,
          commandPathOverride: installPath,
          processPathEnv: commandDir
        })

        await expect(installer.getStatus()).resolves.toMatchObject({
          state: 'stale',
          currentTarget: devLauncherPath
        })
        await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
        await expect(readlink(installPath)).resolves.toBe(launcherPath)
      }
    }
  )
})
