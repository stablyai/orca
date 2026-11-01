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

// awin 5e: a bridge pane reopened or reattached around a reload or relaunch must still know its distro and pane key at Sleep.
describe('a sleeping bridge WSL pane keeps its shell folder across reloads and relaunches', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let harnessAdapter: DaemonPtyAdapter
  let adapter: DaemonPtyAdapter | undefined
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    readRows.mockReset()
    readRows.mockResolvedValue(shellIn('/home/jin/repo/deep/er'))
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
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

  const spawnPane = (
    a: DaemonPtyAdapter,
    sessionId: string,
    env: Record<string, string> | undefined
  ) => a.spawn({ cols: 80, rows: 24, cwd: WSL_CWD, ...(env ? { env } : {}), sessionId })

  it('after a renderer reload re-spawns it with its environment', async () => {
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(adapter, 'repo::/repo@@s1', { ORCA_PANE_KEY: PANE_KEY })
    await spawnPane(adapter, id, { ORCA_PANE_KEY: PANE_KEY })
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('after a relaunch adopts it and the window re-spawns it with its environment', async () => {
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(before, 'repo::/repo@@s2', { ORCA_PANE_KEY: PANE_KEY })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    await adapter.reconcileOnStartup(new Set(['repo::/repo']))
    await spawnPane(adapter, id, { ORCA_PANE_KEY: PANE_KEY })
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('after a relaunch adopts it and the window re-spawns it without its environment', async () => {
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(before, 'repo::/repo@@s3', { ORCA_PANE_KEY: PANE_KEY })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    await adapter.reconcileOnStartup(new Set(['repo::/repo']))
    await spawnPane(adapter, id, undefined)
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('after a relaunch whose window re-spawns it with its environment before adoption', async () => {
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(before, 'repo::/repo@@s4', { ORCA_PANE_KEY: PANE_KEY })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    await spawnPane(adapter, id, { ORCA_PANE_KEY: PANE_KEY })
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('after a relaunch whose window re-spawns it without its environment before adoption', async () => {
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(before, 'repo::/repo@@s5', { ORCA_PANE_KEY: PANE_KEY })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    await spawnPane(adapter, id, undefined)
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\deep\\er`)
  })

  it('when slept again after a wake, at the folder it moved to', async () => {
    vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(true)
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(adapter, 'repo::/repo@@s6', { ORCA_PANE_KEY: PANE_KEY })
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    readRows.mockResolvedValue(shellIn('/home/jin/repo/other'))
    await spawnPane(adapter, id, { ORCA_PANE_KEY: PANE_KEY })
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\other`)
  })

  it('when a woken pane is slept by a relaunched app that only adopted it', async () => {
    vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(true)
    const before = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    const { id } = await spawnPane(before, 'repo::/repo@@s7', { ORCA_PANE_KEY: PANE_KEY })
    await before.shutdown(id, { immediate: true, keepHistory: true })
    await spawnPane(before, id, { ORCA_PANE_KEY: PANE_KEY })
    await before.disconnectOnly()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir() })
    await adapter.reconcileOnStartup(new Set(['repo::/repo']))
    readRows.mockResolvedValue(shellIn('/home/jin/repo/other'))
    await adapter.shutdown(id, { immediate: true, keepHistory: true })
    expect(checkpointCwd(id)).toBe(`${WSL_CWD}\\other`)
  })
})
