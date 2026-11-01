// Linux runtime migration must adopt busy Electron daemons before starting Node replacements.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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

type Runtime = 'electron' | 'node'

const requireFromTest = createRequire(import.meta.url)
const linux = process.platform === 'linux'
let root = ''
let launcher = ''
let client = ''
let appPath = ''
const runtimes: Record<Runtime, string> = { electron: '', node: '' }
const shells = new Set<number>()
const profiles = new Set<string>()

function openWindow(
  runtime: Runtime,
  userData: string,
  appVersion: string
): Promise<LauncherWindow> {
  return openLauncherWindow(
    runtimes[runtime],
    [launcher, userData, appPath, appVersion],
    daemonTestEnv(runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {})
  )
}

async function session(
  op: 'create' | 'attach',
  userData: string,
  sessionId: string,
  marker: string
): Promise<DaemonSessionClientResult> {
  const result = await runProcess({
    program: runtimes.node,
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

function newProfile(name: string): string {
  const userData = join(root, name)
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  profiles.add(userData)
  return userData
}

describe.runIf(linux)('an Electron-hosted daemon meeting a Node-hosted launcher', () => {
  beforeAll(async () => {
    const electron: unknown = requireFromTest('electron')
    if (typeof electron !== 'string') {
      throw new Error('The Electron executable is unavailable')
    }
    runtimes.electron = realpathSync(electron)
    runtimes.node = realpathSync(locatePinnedNodeForTests() ?? process.execPath)
    // Keep the daemon socket path within sun_path.
    root = realpathSync(mkdtempSync('/tmp/orca-e2n-'))
    appPath = join(root, 'app')
    launcher = join(root, 'launcher.cjs')
    client = join(root, 'client.cjs')
    await Promise.all([
      installDaemonEntry(join(appPath, 'out'), join(appPath, 'node_modules')),
      buildDaemonLauncherDriver(launcher),
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

  it.for([
    ['the same build', '1.0.0'],
    ['an upgraded build', '1.1.0']
  ] as const)(
    'keeps a busy Electron daemon and its terminal when %s relaunches on Node',
    { timeout: 120_000 },
    async ([, nextVersion]) => {
      const userData = newProfile(`busy-${nextVersion}`)
      const previous = await openWindow('electron', userData, '1.0.0')
      expect(previous.result).toEqual({ adopted: false, mode: null })
      const pid = profileDaemonPid(userData)
      expect(pid).not.toBeNull()
      expect(executableOf(pid!)).toBe(runtimes.electron)

      const created = await session('create', userData, 'e2n-live', 'BEFORE')
      expect(created).toMatchObject({ isReattach: false, output: true })
      await previous.quit()
      expect(isProcessAlive(pid!)).toBe(true)

      const next = await openWindow('node', userData, nextVersion)
      expect(next.result).toEqual({ adopted: true, mode: null })
      expect(profileDaemonPid(userData)).toBe(pid)
      expect(isProcessAlive(created.pid)).toBe(true)
      const attached = await session('attach', userData, 'e2n-live', 'AFTER')
      expect(attached).toEqual({ pid: created.pid, isReattach: true, output: true })
      await next.quit()
      expect(isProcessAlive(pid!)).toBe(true)
    }
  )

  it(
    'starts the next daemon on Node once the Electron daemon has retired',
    { timeout: 120_000 },
    async () => {
      const userData = newProfile('retired')
      const previous = await openWindow('electron', userData, '1.0.0')
      const oldPid = profileDaemonPid(userData)
      expect(oldPid).not.toBeNull()
      await previous.quit()
      await vi.waitFor(() => expect(isProcessAlive(oldPid!)).toBe(false), { timeout: 30_000 })

      const next = await openWindow('node', userData, '1.1.0')
      expect(next.result).toEqual({ adopted: false, mode: null })
      const newPid = profileDaemonPid(userData)
      expect(newPid).not.toBe(oldPid)
      expect(executableOf(newPid!)).toBe(runtimes.node)
      expect(await session('create', userData, 'e2n-fresh', 'FRESH')).toMatchObject({
        isReattach: false,
        output: true
      })
      await next.quit()
    }
  )
})
