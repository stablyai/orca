// Bridge bash reports no folder; a distro stopped while Orca was quit left the pane at its spawn folder.
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
const DEEP = `${WSL_CWD}\\deep`

/** Shortens quit's folder budget so an unanswering distro is not a real-time wait. */
class QuickQuitDaemonPtyAdapter extends DaemonPtyAdapter {
  protected quitWslCwdBudgetMs = 5
}

describe('a bridge WSL pane keeps its shell folder across quit', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let harnessAdapter: DaemonPtyAdapter
  let adapters: DaemonPtyAdapter[] = []
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const spawnCwds: (string | undefined)[] = []
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    readRows.mockReset()
    readRows.mockResolvedValue([
      { pid: 10, ppid: 1, comm: 'bash', paneKey: PANE_KEY, cwd: '/home/jin/repo/deep' }
    ])
    spawnCwds.length = 0
    const harness = await startDaemonAdapterHarness((opts) => {
      spawnCwds.push(opts.cwd)
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
    for (const adapter of adapters) {
      adapter.dispose()
    }
    adapters = []
    harnessAdapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const historyDir = () => join(dir, 'history')
  const launch = (Adapter: typeof DaemonPtyAdapter = DaemonPtyAdapter) => {
    const adapter = new Adapter({ socketPath, tokenPath, historyPath: historyDir() })
    adapters.push(adapter)
    return adapter
  }
  const checkpointCwd = (id: string) =>
    JSON.parse(
      readFileSync(join(historyDir(), getHistorySessionDirName(id), 'checkpoint.json'), 'utf-8')
    ).cwd
  const openBridgePane = (adapter: DaemonPtyAdapter, sessionId: string, cwd = WSL_CWD) =>
    adapter.spawn({ cols: 80, rows: 24, cwd, env: { ORCA_PANE_KEY: PANE_KEY }, sessionId })

  it("saves the shell's folder in quit's final checkpoint, never booting the distro", async () => {
    const app = launch()
    const { id } = await openBridgePane(app, 'repo::/repo@@quit')
    lastSubprocess._simulateData('$ cd deep\r\n')

    await app.disconnectOnly()

    // `running` lets the read skip its check only when the running-distro cache confirms it.
    expect(readRows).toHaveBeenCalledWith('Ubuntu', expect.any(Number), { running: true })
    expect(checkpointCwd(id)).toBe(DEEP)
  })

  it('reopens in that folder when the distro stopped while Orca was quit', async () => {
    vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(true)
    const app = launch()
    const { id } = await openBridgePane(app, 'repo::/repo@@terminated')
    lastSubprocess._simulateData('$ cd deep\r\n')
    await app.disconnectOnly()
    // `wsl --terminate` ends the bridge's wsl.exe; the daemon reaps the session.
    lastSubprocess._simulateExit(1)

    const relaunched = launch()
    await relaunched.reconcileOnStartup(new Set(['repo::/repo']))
    const restored = await openBridgePane(relaunched, id)

    expect(restored.coldRestore).toBeTruthy()
    expect(spawnCwds.at(-1)).toBe(DEEP)
  })

  it('keeps the spawn folder when the distro cannot be read', async () => {
    readRows.mockResolvedValue(null)
    const app = launch()
    const { id } = await openBridgePane(app, 'repo::/repo@@unreadable')

    await app.disconnectOnly()

    expect(checkpointCwd(id)).toBe(WSL_CWD)
  })

  it('quits on its budget when the distro does not answer', async () => {
    readRows.mockReturnValue(new Promise(() => {}))
    const app = launch(QuickQuitDaemonPtyAdapter)
    const { id } = await openBridgePane(app, 'repo::/repo@@silent')

    await app.disconnectOnly()

    expect(readRows.mock.calls[0]?.[1]).toBe(5)
    expect(checkpointCwd(id)).toBe(WSL_CWD)
  })

  it('reads no distro for a pane that is not a WSL pane', async () => {
    const app = launch()
    await openBridgePane(app, 'repo::/repo@@windows', 'C:\\repo')

    await app.disconnectOnly()

    expect(readRows).not.toHaveBeenCalled()
  })
})
