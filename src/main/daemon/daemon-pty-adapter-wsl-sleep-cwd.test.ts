import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { WslGuestProcessRow } from '../wsl/wsl-guest-pane-processes'
import type * as GuestProcessesModule from '../wsl/wsl-guest-pane-processes'
import * as startupCwdProbe from '../ipc/pty/host-env/startup-cwd-directory-exists'

const readRows = vi.hoisted(() =>
  vi.fn(
    async (
      _distro: string,
      _timeoutMs: number,
      _opts?: { running?: boolean }
    ): Promise<WslGuestProcessRow[] | null> => null
  )
)
vi.mock('../wsl/wsl-guest-pane-processes', async (importOriginal) => ({
  ...(await importOriginal<typeof GuestProcessesModule>()),
  readWslGuestPaneProcesses: readRows
}))

const PANE_KEY = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'

function shellIn(cwd: string): WslGuestProcessRow[] {
  return [
    { pid: 10, ppid: 1, comm: 'bash', paneKey: PANE_KEY, cwd },
    { pid: 11, ppid: 10, comm: 'sleep', paneKey: PANE_KEY, cwd: '/tmp' }
  ]
}

describe('a sleeping bridge WSL pane keeps its shell folder', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let harnessAdapter: DaemonPtyAdapter
  let adapter: DaemonPtyAdapter | undefined
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const spawnCwds: (string | undefined)[] = []
  const deletedCwds = new Set<string>()
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    readRows.mockReset()
    readRows.mockResolvedValue(shellIn('/home/jin/repo/deep/er'))
    spawnCwds.length = 0
    deletedCwds.clear()
    const harness = await startDaemonAdapterHarness((opts) => {
      spawnCwds.push(opts.cwd)
      if (opts.cwd && deletedCwds.has(opts.cwd)) {
        throw new Error(`Working directory "${opts.cwd}" does not exist. It may have been deleted.`)
      }
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    ;({ dir, socketPath, tokenPath, server } = harness)
    harnessAdapter = harness.adapter
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    adapter?.dispose()
    harnessAdapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const historyDir = () => join(dir, 'history')
  const checkpointCwd = (id: string) =>
    JSON.parse(
      readFileSync(join(historyDir(), getHistorySessionDirName(id), 'checkpoint.json'), 'utf-8')
    ).cwd

  it('reads the folder inside the distro before the final checkpoint', async () => {
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: WSL_CWD,
      env: { ORCA_PANE_KEY: PANE_KEY },
      sessionId: 'repo::/repo@@spawned'
    })

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(readRows).toHaveBeenCalledWith('Ubuntu', expect.any(Number), { running: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  // awin verify-9: panes cd'd before a relaunch and slept before the window reopened them
  // reopened at the root; the relaunched app had never learned their distro or pane key.
  it('reads it for a pane a relaunched app adopted but never reattached', async () => {
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await before.spawn({
      cols: 80,
      rows: 24,
      cwd: WSL_CWD,
      env: { ORCA_PANE_KEY: PANE_KEY },
      sessionId: 'repo::/repo@@relaunch'
    })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    expect((await adapter.reconcileOnStartup(new Set(['repo::/repo']))).alive).toContain(id)

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(readRows).toHaveBeenCalledWith('Ubuntu', expect.any(Number), { running: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('wakes the pane in that folder', async () => {
    // The UNC folder exists only in name on this machine.
    vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(true)
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const spawn = () =>
      adapter!.spawn({
        cols: 80,
        rows: 24,
        cwd: WSL_CWD,
        env: { ORCA_PANE_KEY: PANE_KEY },
        sessionId: 'repo::/repo@@wake'
      })
    const { id } = await spawn()
    lastSubprocess._simulateData('$ cd deep/er\r\n')
    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    await spawn()

    expect(spawnCwds.at(-1)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('wakes at the folder it was asked for when the one it slept in was deleted', async () => {
    // The guest cannot say whether the folder exists, so the spawn itself finds it gone.
    vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(null)
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const spawn = () =>
      adapter!.spawn({
        cols: 80,
        rows: 24,
        cwd: WSL_CWD,
        env: { ORCA_PANE_KEY: PANE_KEY },
        sessionId: 'repo::/repo@@deleted'
      })
    const { id } = await spawn()
    lastSubprocess._simulateData('$ cd deep/er\r\n')
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    deletedCwds.add(`${WSL_CWD}\\deep\\er`)

    const woken = await spawn()

    expect(spawnCwds.slice(-2)).toEqual([`${WSL_CWD}\\deep\\er`, WSL_CWD])
    expect(woken.coldRestore).toBeTruthy()
  })

  it('keeps the spawn folder when the distro cannot be read', async () => {
    readRows.mockResolvedValue(null)
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: WSL_CWD,
      env: { ORCA_PANE_KEY: PANE_KEY },
      sessionId: 'repo::/repo@@unreadable'
    })

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(checkpointCwd(id)).toBe(WSL_CWD)
  })

  it('never reads a distro for a pane that is not a WSL pane', async () => {
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      env: { ORCA_PANE_KEY: PANE_KEY },
      sessionId: 'repo::/repo@@windows'
    })

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(readRows).not.toHaveBeenCalled()
  })
})
