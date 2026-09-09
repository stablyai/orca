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

const { appMetricsMock, runProcessMock, execMock, listRegisteredPtysMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => AppMetricFixture[]>(() => []),
  runProcessMock: vi.fn(),
  execMock: vi.fn(),
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))

// Why mock the chokepoint for the Windows sweep: maxBuffer, timeout and the
// hidden console are its contract now, so the assertions below are about which
// query runs, not how a process is started.
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: { program: string; args?: string[] }) => runProcessMock(spec)
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
    runProcessMock.mockReset()
    execMock.mockReset()
    listRegisteredPtysMock.mockReset()
    listRegisteredPtysMock.mockReturnValue([])
  })

  function mockPsResponse(stdout: string) {
    execMock.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: '' }))
    runProcessMock.mockImplementation((spec: { program: string }) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout:
          spec.program === 'typeperf.exe'
            ? psFixtureToTypeperfOutput(stdout)
            : psFixtureToWindowsProcessOutput(stdout),
        stderr: '',
        timedOut: false
      })
    )
  }

  function psFixtureToWindowsProcessOutput(stdout: string): string {
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, _cpu, rssKb] = line.split(/\s+/, 4)
        const memory = Number.parseInt(rssKb ?? '', 10)
        return [
          pid ?? '',
          ppid ?? '',
          Number.isFinite(memory) && memory > 0 ? memory * 1024 : 0,
          '0',
          '0',
          '1'
        ].join('\t')
      })
      .join('\r\n')
  }

  function psFixtureToTypeperfOutput(stdout: string): string {
    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const [pid, ppid, _cpu, rssKb] = line.split(/\s+/, 4)
        const memoryKb = Number.parseInt(rssKb ?? '', 10)
        return {
          instance: `fixture${index}`,
          pid: pid ?? '',
          ppid: ppid ?? '',
          memory: Number.isFinite(memoryKb) && memoryKb > 0 ? memoryKb * 1024 : 0
        }
      })
    const counterColumns = (counter: string): string[] =>
      rows.map((row) => `"\\\\HOST\\Process(${row.instance})\\${counter}"`)
    const valueColumns = (field: 'pid' | 'ppid' | 'memory'): string[] =>
      rows.map((row) => `"${row[field]}"`)

    return [
      [
        '"(PDH-CSV 4.0)"',
        ...counterColumns('ID Process'),
        ...counterColumns('Creating Process ID'),
        ...counterColumns('Working Set')
      ].join(','),
      ['"time"', ...valueColumns('pid'), ...valueColumns('ppid'), ...valueColumns('memory')].join(
        ','
      )
    ].join('\r\n')
  }

  it('uses one CIM process for Windows memory and CPU sampling', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    mockPsResponse('10 1 0 1024')
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)

    expect(execMock).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    const spec = runProcessMock.mock.calls[0][0]
    expect(spec.program).toBe('powershell.exe')
    expect(spec.args.join(' ')).toContain('Get-CimInstance Win32_Process')
    expect(spec.args.join(' ')).toContain('KernelModeTime')
    expect(spec.args.join(' ')).toContain('UserModeTime')
    expect(spec.args.join(' ')).toContain('CreationDate')
    expect(spec).toMatchObject({ maxOutputBytes: 10 * 1024 * 1024, timeoutMs: 5_000 })
  })

  it('attributes Windows process CPU from cumulative time deltas between sweeps', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    const cpuOutputs = [
      '10\t1\t1048576\t10000000\t0\t638830000000000000',
      '10\t1\t1048576\t30000000\t0\t638830000000000000'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'windows-cpu-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const first = await collectMemorySnapshot(emptyStore)
    const second = await collectMemorySnapshot(emptyStore)

    expect(first.worktrees[0].sessions[0].cpu).toBe(0)
    expect(second.worktrees[0].sessions[0].cpu).toBe(100)
    expect(runProcessMock.mock.calls.map(([spec]) => spec.program)).toEqual([
      'powershell.exe',
      'powershell.exe'
    ])
  })

  it('does not attribute prior CPU time after Windows reuses a process id', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    const cpuOutputs = [
      '10\t1\t1048576\t10000000\t0\t638830000000000000',
      '10\t1\t1048576\t30000000\t0\t638830000000000001'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'reused-pid-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const second = await collectMemorySnapshot(emptyStore)

    expect(second.worktrees[0].sessions[0].cpu).toBe(0)
  })

  it('supports cumulative CPU counters above JavaScript safe integers', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    const cpuOutputs = [
      '10\t1\t1048576\t90071992547409920\t0\t638830000000000000',
      '10\t1\t1048576\t90071992567409920\t0\t638830000000000000'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'large-counter-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const second = await collectMemorySnapshot(emptyStore)

    expect(second.worktrees[0].sessions[0].cpu).toBe(100)
  })

  it('keeps the older CPU baseline when forced snapshots are too close together', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(3_000)
    const cpuOutputs = [
      '10\t1\t1048576\t0\t0\t638830000000000000',
      '10\t1\t1048576\t1000000\t0\t638830000000000000',
      '10\t1\t1048576\t20000000\t0\t638830000000000000'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'short-sample-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const tooSoon = await collectMemorySnapshot(emptyStore)
    const normalPoll = await collectMemorySnapshot(emptyStore)

    expect(tooSoon.worktrees[0].sessions[0].cpu).toBe(0)
    expect(normalPoll.worktrees[0].sessions[0].cpu).toBe(100)
  })

  it('caps impossible Windows CPU deltas at the host core capacity', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(os, 'cpus').mockReturnValue([{}, {}] as ReturnType<typeof os.cpus>)
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_000)
    const cpuOutputs = [
      '10\t1\t1048576\t0\t0\t638830000000000000',
      '10\t1\t1048576\t1000000000\t0\t638830000000000000'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'impossible-cpu-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const capped = await collectMemorySnapshot(emptyStore)

    expect(capped.worktrees[0].sessions[0].cpu).toBe(200)
  })

  it('warms CPU sampling again after Resource Manager was closed', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(12_000)
    const cpuOutputs = [
      '10\t1\t1048576\t0\t0\t638830000000000000',
      '10\t1\t1048576\t100000000\t0\t638830000000000000'
    ]
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: cpuOutputs.shift() ?? '',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'stale-counter-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    const reopened = await collectMemorySnapshot(emptyStore)

    expect(reopened.worktrees[0].sessions[0].cpu).toBe(0)
  })

  it('preserves Windows process memory when CPU counters are unavailable', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: '10\t1\t1048576\t\t\t638830000000000000',
        stderr: '',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'cpu-failure-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0]).toMatchObject({ cpu: 0, memory: 1024 * 1024 })
  })

  it('uses Typeperf during the CIM retry cooldown', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    runProcessMock.mockImplementation((spec: { program: string }) =>
      Promise.resolve(
        spec.program === 'powershell.exe'
          ? { code: 1, signal: null, stdout: '', stderr: 'CIM unavailable', timedOut: false }
          : {
              code: 0,
              signal: null,
              stdout: psFixtureToTypeperfOutput('10 1 0 1024'),
              stderr: '',
              timedOut: false
            }
      )
    )
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'cim-pty',
        worktreeId: null,
        sessionId: null,
        paneKey: null,
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const first = await collectMemorySnapshot(emptyStore)
    const second = await collectMemorySnapshot(emptyStore)

    expect(runProcessMock).toHaveBeenCalledTimes(3)
    expect(runProcessMock.mock.calls.map(([spec]) => spec.program)).toEqual([
      'powershell.exe',
      'typeperf.exe',
      'typeperf.exe'
    ])
    expect(runProcessMock.mock.calls[1][0]).toMatchObject({ timeoutMs: 5_000 })
    expect(first.worktrees[0].memory).toBe(1048576)
    expect(second.worktrees[0].memory).toBe(1048576)
  })

  it('retries CIM after fallback and warms CPU sampling before restoring deltas', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(31_001)
      .mockReturnValueOnce(32_000)
      .mockReturnValueOnce(34_000)
    const cimOutputs = [
      '10\t1\t1048576\t10000000\t0\t638830000000000000',
      '10\t1\t1048576\t30000000\t0\t638830000000000000'
    ]
    let cimCalls = 0
    runProcessMock.mockImplementation((spec: { program: string }) => {
      if (spec.program === 'typeperf.exe') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: psFixtureToTypeperfOutput('10 1 0 1024'),
          stderr: '',
          timedOut: false
        })
      }
      cimCalls += 1
      return Promise.resolve(
        cimCalls === 1
          ? { code: 1, signal: null, stdout: '', stderr: 'transient CIM failure', timedOut: false }
          : {
              code: 0,
              signal: null,
              stdout: cimOutputs.shift() ?? '',
              stderr: '',
              timedOut: false
            }
      )
    })
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'recovering-cim-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    await collectMemorySnapshot(emptyStore)
    const warming = await collectMemorySnapshot(emptyStore)
    const recovered = await collectMemorySnapshot(emptyStore)

    expect(runProcessMock.mock.calls.map(([spec]) => spec.program)).toEqual([
      'powershell.exe',
      'typeperf.exe',
      'typeperf.exe',
      'powershell.exe',
      'powershell.exe'
    ])
    expect(warming.worktrees[0].sessions[0].cpu).toBe(0)
    expect(recovered.worktrees[0].sessions[0].cpu).toBe(100)
  })

  it('sums committed private bytes across the whole PTY subtree on Windows', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    // Working set stays small while commit is 10-40x larger — the reported shape.
    const rows = [
      '10\t1\t52428800\t0\t0\t638830000000000000\t1048576',
      '11\t10\t104857600\t0\t0\t638830000000000000\t2097152',
      '12\t11\t52428800\t0\t0\t638830000000000000\t524288',
      '900\t1\t20971520\t0\t0\t638830000000000000\t262144'
    ].join('\r\n')
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: rows,
      stderr: '',
      timedOut: false
    })
    appMetricsMock.mockReturnValue([
      { pid: 900, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } }
    ])
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    const committedKb = 1048576 + 2097152 + 524288
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBe(committedKb * 1024)
    expect(snapshot.worktrees[0].privateMemory).toBe(committedKb * 1024)
    expect(snapshot.app.privateMemory).toBe(262144 * 1024)
    expect(snapshot.totalPrivateMemory).toBe((committedKb + 262144) * 1024)
    expect(snapshot.processCommitMetric).toBe('private-bytes')
    // The resident figure keeps its old meaning rather than being redefined.
    expect(snapshot.processMemoryMetric).toBe('working-set')
    expect(snapshot.worktrees[0].memory).toBe(52428800 + 104857600 + 52428800)
  })

  it('omits the commit metric entirely when the Windows sweep cannot report it', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '10\t1\t52428800\t0\t0\t638830000000000000',
      stderr: '',
      timedOut: false
    })
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    // Why not zero: a host that cannot measure commit must be distinguishable
    // from agents that hold none.
    expect(snapshot.processCommitMetric).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].privateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
    expect(snapshot.app.privateMemory).toBeUndefined()
    expect(snapshot.totalMemory).toBe(52428800)
  })

  it('carries no commit metric on Unix, where ps has no committed-bytes column', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    mockPsResponse('10 1 0 1024')
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::/repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('rss')
    expect(snapshot.processCommitMetric).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
  })

  it("attributes a shared ancestor's commit to one PTY only", async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: [
        '10\t1\t1024\t0\t0\t638830000000000000\t1024',
        '11\t10\t1024\t0\t0\t638830000000000000\t2048'
      ].join('\r\n'),
      stderr: '',
      timedOut: false
    })
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'a', worktreeId: 'repo::C:\\a', sessionId: 's-a', paneKey: null, pid: 10 },
      { ptyId: 'b', worktreeId: 'repo::C:\\b', sessionId: 's-b', paneKey: null, pid: 11 }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBe((1024 + 2048) * 1024)
    expect(snapshot.worktrees[1].sessions[0].privateMemory).toBe(0)
    expect(snapshot.totalPrivateMemory).toBe((1024 + 2048) * 1024)
  })
})
