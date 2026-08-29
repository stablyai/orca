import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { MemorySnapshotStore } from './collector'
import { setAppEnvironment } from '../../shared/app-environment'

type AppMetricFixture = {
  pid: number
  type: string
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
}

type WindowsRow = {
  pid: number
  ppid: number
  name: string
  command: string
  memoryBytes?: number
  privateMemoryBytes?: number
  cpuTimeTicks?: string
  startTimeId?: string
}

const {
  appMetricsMock,
  execMock,
  listRegisteredPtysMock,
  readWindowsProcessTableMock,
  runProcessMock
} = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => AppMetricFixture[]>(() => []),
  execMock: vi.fn(),
  listRegisteredPtysMock: vi.fn(),
  readWindowsProcessTableMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: { program: string; args?: string[] }) => runProcessMock(spec)
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTableSnapshot: async () => ({
    rows: await readWindowsProcessTableMock(),
    capturedAtMs: performance.now()
  })
}))

vi.mock('./pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

function appEnvironment() {
  return {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: appMetricsMock
  }
}

async function loadCollector() {
  vi.resetModules()
  const { setAppEnvironment: setResetAppEnvironment } = await import('../../shared/app-environment')
  setResetAppEnvironment(appEnvironment())
  return await import('./collector')
}

function row(pid: number, ppid: number, fields: Partial<WindowsRow> = {}): WindowsRow {
  return { pid, ppid, name: `process-${pid}.exe`, command: '', ...fields }
}

function registerPty(pid: number, worktreeId = 'repo-1::C:\\repo') {
  listRegisteredPtysMock.mockReturnValue([
    {
      ptyId: `pty-${pid}`,
      worktreeId,
      sessionId: `session-${pid}`,
      paneKey: `pane-${pid}`,
      pid
    }
  ])
}

const emptyStore = {
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

describe('collectMemorySnapshot on Windows', () => {
  beforeEach(() => {
    setAppEnvironment(appEnvironment())
    vi.restoreAllMocks()
    appMetricsMock.mockReset()
    appMetricsMock.mockReturnValue([])
    execMock.mockReset()
    listRegisteredPtysMock.mockReset()
    listRegisteredPtysMock.mockReturnValue([])
    readWindowsProcessTableMock.mockReset()
    readWindowsProcessTableMock.mockResolvedValue([])
    runProcessMock.mockReset()
  })

  it('uses the native inventory without launching a process and preserves large metrics', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    registerPty(10)
    readWindowsProcessTableMock.mockResolvedValue([
      row(10, 1, {
        memoryBytes: 5_000_000_000,
        privateMemoryBytes: 6_000_000_000,
        cpuTimeTicks: '90071992547409920',
        startTimeId: '134324351598335799'
      })
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(readWindowsProcessTableMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
    expect(snapshot.worktrees[0].sessions[0]).toMatchObject({
      cpu: 0,
      memory: 5_000_000_000,
      privateMemory: 6_000_000_000
    })
    expect(snapshot.processMemoryMetric).toBe('working-set')
    expect(snapshot.processCommitMetric).toBe('private-bytes')
  })

  it('attributes CPU from exact cumulative counters above safe integers', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    registerPty(10)
    readWindowsProcessTableMock
      .mockResolvedValueOnce([
        row(10, 1, {
          memoryBytes: 1_048_576,
          cpuTimeTicks: '90071992547409920',
          startTimeId: '134324351598335799'
        })
      ])
      .mockResolvedValueOnce([
        row(10, 1, {
          memoryBytes: 1_048_576,
          cpuTimeTicks: '90071992567409920',
          startTimeId: '134324351598335799'
        })
      ])
    const { collectMemorySnapshot } = await loadCollector()

    const first = await collectMemorySnapshot(emptyStore)
    const second = await collectMemorySnapshot(emptyStore)

    expect(first.worktrees[0].sessions[0].cpu).toBe(0)
    expect(second.worktrees[0].sessions[0].cpu).toBe(100)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('does not advance the CPU baseline when a cached capture is reused', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_000)
    registerPty(10)
    const firstRow = row(10, 1, {
      cpuTimeTicks: '90071992547409920',
      startTimeId: '134324351598335799'
    })
    readWindowsProcessTableMock
      .mockResolvedValueOnce([firstRow])
      .mockResolvedValueOnce([firstRow])
      .mockResolvedValueOnce([
        row(10, 1, {
          cpuTimeTicks: '90071992567409920',
          startTimeId: '134324351598335799'
        })
      ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const cached = await collectMemorySnapshot(emptyStore)
    const refreshed = await collectMemorySnapshot(emptyStore)

    expect(cached.worktrees[0].sessions[0].cpu).toBe(0)
    expect(refreshed.worktrees[0].sessions[0].cpu).toBe(100)
  })

  it('does not carry CPU across a recycled PID', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    registerPty(10)
    readWindowsProcessTableMock
      .mockResolvedValueOnce([
        row(10, 1, { cpuTimeTicks: '10000000', startTimeId: '134324351598335799' })
      ])
      .mockResolvedValueOnce([
        row(10, 1, { cpuTimeTicks: '30000000', startTimeId: '134324351598335800' })
      ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const recycled = await collectMemorySnapshot(emptyStore)

    expect(recycled.worktrees[0].sessions[0].cpu).toBe(0)
  })

  it('keeps working-set data when CPU or private metrics are unavailable', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    registerPty(10)
    readWindowsProcessTableMock.mockResolvedValue([row(10, 1, { memoryBytes: 52_428_800 })])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0]).toMatchObject({ cpu: 0, memory: 52_428_800 })
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
    expect(snapshot.processCommitMetric).toBeUndefined()
  })

  it('sums private bytes across a PTY subtree and app processes', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    registerPty(10)
    appMetricsMock.mockReturnValue([
      { pid: 900, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } }
    ])
    readWindowsProcessTableMock.mockResolvedValue([
      row(10, 1, { memoryBytes: 50, privateMemoryBytes: 1_024 }),
      row(11, 10, { memoryBytes: 100, privateMemoryBytes: 2_048 }),
      row(12, 11, { memoryBytes: 50, privateMemoryBytes: 512 }),
      row(900, 1, { memoryBytes: 20, privateMemoryBytes: 256 })
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBe(3_584)
    expect(snapshot.worktrees[0].memory).toBe(200)
    expect(snapshot.app.privateMemory).toBe(256)
    expect(snapshot.totalPrivateMemory).toBe(3_840)
  })

  it('omits partial private-byte aggregates when an owned process is unreadable', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    registerPty(10)
    appMetricsMock.mockReturnValue([
      { pid: 900, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } }
    ])
    readWindowsProcessTableMock.mockResolvedValue([
      row(10, 1, { memoryBytes: 50, privateMemoryBytes: 1_024 }),
      row(11, 10, { memoryBytes: 100 }),
      row(900, 1, { memoryBytes: 20, privateMemoryBytes: 256 })
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processCommitMetric).toBe('private-bytes')
    expect(snapshot.app.privateMemory).toBe(256)
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].privateMemory).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
  })

  it("attributes a shared ancestor's private bytes to one PTY only", async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'a', worktreeId: 'repo::C:\\a', sessionId: 's-a', paneKey: null, pid: 10 },
      { ptyId: 'b', worktreeId: 'repo::C:\\b', sessionId: 's-b', paneKey: null, pid: 11 }
    ])
    readWindowsProcessTableMock.mockResolvedValue([
      row(10, 1, { memoryBytes: 1, privateMemoryBytes: 1_024 }),
      row(11, 10, { memoryBytes: 1, privateMemoryBytes: 2_048 })
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBe(3_072)
    expect(snapshot.worktrees[1].sessions[0].privateMemory).toBe(0)
  })

  it('rejects unavailable data without falling back to a subprocess', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    readWindowsProcessTableMock.mockRejectedValue(new Error('native inventory unavailable'))
    const { collectMemorySnapshot } = await loadCollector()

    await expect(collectMemorySnapshot(emptyStore)).rejects.toThrow('native inventory unavailable')
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
  })

  it('carries no private metric on Unix', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    execMock.mockImplementation(
      (_cmd, _opts, cb: (err: Error | null, out: { stdout: string }) => void) =>
        cb(null, { stdout: '10 1 0 1024' })
    )
    registerPty(10, 'repo-1::/repo')
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('rss')
    expect(snapshot.processCommitMetric).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
  })
})
