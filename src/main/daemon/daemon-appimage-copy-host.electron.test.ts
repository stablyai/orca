/**
 * The AppImage desktop's terminal daemon across an upgrade onto the extracted copy (D3-D3): the
 * previous build's busy Electron daemon is kept with its terminal, and once it retires the next
 * daemon runs on the copy's bundled Node, leases its generation, and keeps serving after the
 * window's mount is gone. The FUSE runtime is simulated (no AppImage can mount in a test); the
 * launcher runs under the real Electron and everything after the runtime check is real. Linux only.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  buildDaemonLauncherDriver,
  closeLauncherWindows,
  daemonTestEnv,
  executableOf,
  installDaemonEntry,
  isProcessAlive,
  openLauncherWindow,
  profileDaemonEntryIdentity,
  profileDaemonPid,
  type LauncherWindow
} from './daemon-launcher-driver-fixture'
import {
  buildDaemonSessionClient,
  type DaemonSessionClientResult
} from '../orcad/orcad-daemon-session-client-fixture'
import {
  killAndAwaitExit,
  killProfileDaemons,
  removeTestRoot
} from '../orcad/orcad-daemon-teardown-fixture'
import { locatePinnedNodeForTests } from '../orcad/orcad-node-slot-fixture'
import { resolveAppImageExtractedRoot } from '../cli/appimage-extracted-root'

const ENTRY_IN_APPDIR = 'resources/app.asar.unpacked/out/main/daemon-entry.js'
const requireFromTest = createRequire(import.meta.url)
const linux = process.platform === 'linux'
let root = ''
let launcher = ''
let client = ''
let electron = ''
let node = ''
const shells = new Set<number>()
const profiles = new Set<string>()

type AppImageInstall = { appImagePath: string; mountPath: string; cacheHome: string }

function cacheRootOf(install: AppImageInstall): string {
  return join(install.cacheHome, 'orca', 'appimage')
}

/** A mounted AppImage: the file at $APPIMAGE and its payload at $APPDIR. */
async function installAppImage(name: string): Promise<AppImageInstall> {
  const base = join(root, name)
  const install = {
    appImagePath: join(base, 'Orca.AppImage'),
    mountPath: join(base, 'mount'),
    cacheHome: join(base, 'cache')
  }
  mkdirSync(base, { recursive: true })
  writeFileSync(install.appImagePath, 'release 1.0.0')
  const resources = join(install.mountPath, 'resources')
  await installDaemonEntry(
    join(resources, 'app.asar.unpacked', 'out'),
    join(resources, 'node_modules')
  )
  return install
}

/** What `orca` registration extracts for the file now at $APPIMAGE, optionally without Node. */
function extractCopy(install: AppImageInstall, version: string, withNode = true): string {
  const generation = resolveAppImageExtractedRoot({
    appImagePath: install.appImagePath,
    cacheRootPath: cacheRootOf(install)
  })!.rootPath
  const resources = join(generation, 'resources')
  mkdirSync(join(resources, 'bin'), { recursive: true })
  writeFileSync(join(resources, 'bin', 'orca-ide'), '#!/bin/sh\n')
  chmodSync(join(resources, 'bin', 'orca-ide'), 0o755)
  cpSync(
    join(install.mountPath, 'resources', 'app.asar.unpacked'),
    join(resources, 'app.asar.unpacked'),
    { recursive: true }
  )
  writeFileSync(
    join(resources, 'app.asar.unpacked', 'out', 'package.json'),
    JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs', version })
  )
  mkdirSync(join(resources, 'node_modules'))
  symlinkSync(
    realpathSync(join(install.mountPath, 'resources', 'node_modules', 'node-pty')),
    join(resources, 'node_modules', 'node-pty')
  )
  if (withNode) {
    const bundled = join(resources, 'node-runtime', 'bin', 'node')
    mkdirSync(dirname(bundled), { recursive: true })
    try {
      linkSync(node, bundled)
    } catch {
      copyFileSync(node, bundled)
      chmodSync(bundled, 0o755)
    }
  }
  return generation
}

function openWindow(
  install: AppImageInstall,
  userData: string,
  appVersion: string
): Promise<LauncherWindow> {
  return openLauncherWindow(
    electron,
    [launcher, userData, join(install.mountPath, 'resources', 'app.asar'), appVersion],
    daemonTestEnv({
      ELECTRON_RUN_AS_NODE: '1',
      APPIMAGE: install.appImagePath,
      APPDIR: install.mountPath,
      XDG_CACHE_HOME: install.cacheHome
    })
  )
}

async function session(
  op: 'create' | 'attach',
  userData: string,
  sessionId: string,
  marker: string
): Promise<DaemonSessionClientResult> {
  const result = await runProcess({
    program: node,
    args: [client, op, join(userData, 'daemon'), sessionId, marker, root],
    env: daemonTestEnv(),
    timeoutMs: 30_000
  })
  expect(result.code, result.stderr).toBe(0)
  const parsed: DaemonSessionClientResult = JSON.parse(
    result.stdout.trim().split('\n').at(-1) ?? ''
  )
  shells.add(parsed.pid)
  return parsed
}

function newProfile(install: AppImageInstall): string {
  const userData = join(dirname(install.mountPath), 'user-data')
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  profiles.add(userData)
  return userData
}

describe.runIf(linux)('the AppImage terminal daemon on the extracted copy', () => {
  beforeAll(async () => {
    const binary: unknown = requireFromTest('electron')
    if (typeof binary !== 'string') {
      throw new Error('The Electron executable is unavailable')
    }
    electron = realpathSync(binary)
    node = realpathSync(locatePinnedNodeForTests() ?? process.execPath)
    // Short root: the daemon's socket must fit sun_path.
    root = realpathSync(mkdtempSync('/tmp/orca-aic-'))
    launcher = join(root, 'launcher.cjs')
    client = join(root, 'client.cjs')
    await Promise.all([
      buildDaemonLauncherDriver(launcher, { simulateAppImageRuntime: true }),
      buildDaemonSessionClient(client)
    ])
  }, 120_000)

  afterEach(async () => {
    await closeLauncherWindows()
    await killAndAwaitExit(shells)
    shells.clear()
    for (const userData of profiles) {
      await killProfileDaemons(userData)
    }
    profiles.clear()
  })

  afterAll(async () => {
    if (root) {
      await removeTestRoot(root)
    }
  })

  it(
    'moves to the copy across an upgrade without ending a live terminal',
    { timeout: 180_000 },
    async () => {
      const install = await installAppImage('upgrade')
      const userData = newProfile(install)

      // The previous build, with nothing extracted: Electron from the mount, and it says why.
      const previous = await openWindow(install, userData, '1.0.0')
      expect(previous.result).toEqual({ adopted: false, mode: null })
      expect(previous.stderr()).toContain('AppImage daemon host fallback reason=no-extracted-copy')
      const oldPid = profileDaemonPid(userData)!
      expect(executableOf(oldPid)).toBe(electron)
      const live = await session('create', userData, 'aic-live', 'BEFORE')
      await previous.quit()

      // The update replaces the file at $APPIMAGE, and the CLI extracts the new release.
      writeFileSync(install.appImagePath, 'release 1.1.0, a different size')
      const generation = extractCopy(install, '1.1.0')

      const upgraded = await openWindow(install, userData, '1.1.0')
      expect(upgraded.result).toEqual({ adopted: true, mode: null })
      expect(profileDaemonPid(userData)).toBe(oldPid)
      expect(await session('attach', userData, 'aic-live', 'AFTER')).toEqual({
        pid: live.pid,
        isReattach: true,
        output: true
      })

      // The old daemon retires on its own once its last terminal and window are gone.
      process.kill(live.pid, 'SIGKILL')
      await upgraded.quit()
      await vi.waitFor(() => expect(isProcessAlive(oldPid)).toBe(false), { timeout: 30_000 })

      const next = await openWindow(install, userData, '1.1.0')
      expect(next.result).toEqual({ adopted: false, mode: null })
      const pid = profileDaemonPid(userData)!
      expect(executableOf(pid)).toBe(join(generation, 'resources', 'node-runtime', 'bin', 'node'))
      expect(profileDaemonEntryIdentity(userData)).toBe(join(install.appImagePath, ENTRY_IN_APPDIR))
      const [namespaceKey, generationKey] = generation.split('/').slice(-2)
      await vi.waitFor(() =>
        expect(readdirSync(join(cacheRootOf(install), 'leases'))).toContainEqual(
          expect.stringMatching(new RegExp(`^${namespaceKey}\\.${generationKey}\\.${pid}\\.`))
        )
      )
      const kept = await session('create', userData, 'aic-kept', 'ON-NODE')
      await next.quit()

      // The window's mount goes away; nothing the daemon runs or maps lived there.
      rmSync(install.mountPath, { recursive: true, force: true })
      expect(readFileSync(`/proc/${pid}/maps`, 'utf8')).not.toContain(install.mountPath)
      expect(await session('attach', userData, 'aic-kept', 'NO-MOUNT')).toMatchObject({
        pid: kept.pid,
        isReattach: true,
        output: true
      })
      expect(await session('create', userData, 'aic-new', 'NEW-SHELL')).toMatchObject({
        isReattach: false,
        output: true
      })
    }
  )

  it(
    'stays on Electron, and says so, when the extracted copy carries no Node',
    { timeout: 120_000 },
    async () => {
      const install = await installAppImage('no-node')
      const userData = newProfile(install)
      extractCopy(install, '1.0.0', false)
      const window = await openWindow(install, userData, '1.0.0')
      expect(window.result).toEqual({ adopted: false, mode: null })
      expect(window.stderr()).toContain('AppImage daemon host fallback reason=no-bundled-node')
      expect(executableOf(profileDaemonPid(userData)!)).toBe(electron)
      await window.quit()
    }
  )
})
