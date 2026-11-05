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

// Mock the process wrapper; this suite verifies queries, while wrapper tests cover launch policy.
vi.mock('@orca/process-host', () => ({
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
  getFolderWorkspace: () => undefined,
  getProjectGroups: () => [],
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

describe('parsePsOutput', () => {
  it('parses a well-formed listing into rows', async () => {
    const { parsePsOutput } = await loadCollector()
    const stdout = ['  1 0 0.1 1024', '123 1 5.5 2048', '456 123 0.0 512'].join('\n')

    const rows = parsePsOutput(stdout)

    expect(rows).toEqual([
      { pid: 1, ppid: 0, cpu: 0.1, memory: 1024 * 1024 },
      { pid: 123, ppid: 1, cpu: 5.5, memory: 2048 * 1024 },
      { pid: 456, ppid: 123, cpu: 0, memory: 512 * 1024 }
    ])
  })

  it('parses dot-decimal cpu values (LC_ALL=C contract)', async () => {
    const { parsePsOutput } = await loadCollector()
    // C-locale ps output is required: parseFloat silently truncates comma decimals.
    const rows = parsePsOutput('10 1 12.5 1024')
    expect(rows[0].cpu).toBe(12.5)
  })

  it('skips blank lines and rows with too few fields', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput('\n  \n10 1 0.0\n20 1 0.0 512\n')
    expect(rows).toEqual([{ pid: 20, ppid: 1, cpu: 0, memory: 512 * 1024 }])
  })

  it('skips rows whose pid or ppid fail to parse', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput(['abc 1 0.0 100', '10 xyz 0.0 100', '20 1 0.0 100'].join('\n'))
    expect(rows.map((r) => r.pid)).toEqual([20])
  })

  it('clamps negative or NaN cpu/memory to 0', async () => {
    const { parsePsOutput } = await loadCollector()
    const rows = parsePsOutput('10 1 -5 -100')
    expect(rows[0].cpu).toBe(0)
    expect(rows[0].memory).toBe(0)
  })

  it('parses process rows without line-array or whitespace-regex splitting', async () => {
    const { parsePsOutput } = await loadCollector()
    const splitSpy = vi.spyOn(String.prototype, 'split')

    const rows = parsePsOutput('10 1 0.5 256\r\n11 10 0 128')

    const usedUnboundedSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source.includes('\\s+'))
    )
    splitSpy.mockRestore()
    expect(rows).toEqual([
      { pid: 10, ppid: 1, cpu: 0.5, memory: 256 * 1024 },
      { pid: 11, ppid: 10, cpu: 0, memory: 128 * 1024 }
    ])
    expect(usedUnboundedSplit).toBe(false)
  })
})

describe('collectSubtree', () => {
  function makeIndex(rows: { pid: number; ppid: number }[]) {
    const byPid = new Map<number, { pid: number; ppid: number; cpu: number; memory: number }>()
    const childrenOf = new Map<number, number[]>()
    for (const r of rows) {
      byPid.set(r.pid, { ...r, cpu: 0, memory: 0 })
      const kids = childrenOf.get(r.ppid)
      if (kids) {
        kids.push(r.pid)
      } else {
        childrenOf.set(r.ppid, [r.pid])
      }
    }
    return { byPid, childrenOf, hasPrivateMemory: false }
  }

  it('walks every descendant of the root inclusive', async () => {
    const { collectSubtree } = await loadCollector()
    const index = makeIndex([
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 1 },
      { pid: 4, ppid: 2 },
      { pid: 99, ppid: 0 } // unrelated branch
    ])

    const pids = collectSubtree(index, 1).sort((a, b) => a - b)

    expect(pids).toEqual([1, 2, 3, 4])
  })

  it('does not revisit pids when cycles are present', async () => {
    const { collectSubtree } = await loadCollector()
    const index = makeIndex([
      { pid: 1, ppid: 2 },
      { pid: 2, ppid: 1 }
    ])

    const pids = collectSubtree(index, 1).sort((a, b) => a - b)

    expect(pids).toEqual([1, 2])
  })

  it('returns only pids that exist in byPid', async () => {
    const { collectSubtree } = await loadCollector()
    // Exited descendants can remain in the sampled parent index; walk them without fabricating rows.
    const index = {
      byPid: new Map([[1, { pid: 1, ppid: 0, cpu: 0, memory: 0 }]]),
      childrenOf: new Map([[1, [2]]]),
      hasPrivateMemory: false
    }

    expect(collectSubtree(index, 1)).toEqual([1])
  })

  it('does not descend into a subtree already attributed to another PTY', async () => {
    const { collectSubtree } = await loadCollector()
    class CountingChildrenMap extends Map<number, number[]> {
      lookups = 0

      override get(key: number): number[] | undefined {
        this.lookups += 1
        return super.get(key)
      }
    }
    const childrenOf = new CountingChildrenMap([
      [1, [2, 4]],
      [2, [3]],
      [3, [5]]
    ])
    const byPid = new Map([1, 2, 3, 4, 5].map((pid) => [pid, { pid, ppid: 0, cpu: 0, memory: 0 }]))
    const index = { byPid, childrenOf, hasPrivateMemory: false }

    expect(collectSubtree(index, 1, new Set([2]))).toEqual([1, 4])
    // Excluded subtrees must not be expanded again.
    expect(childrenOf.lookups).toBe(2)
  })
})

describe('collectMemorySnapshot', () => {
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

  function expectProcessSweepCount(count: number): void {
    if (os.platform() === 'win32') {
      expect(runProcessMock).toHaveBeenCalledTimes(count)
      return
    }
    expect(execMock).toHaveBeenCalledTimes(count)
  }

  it('coalesces concurrent callers onto a single in-flight sweep', async () => {
    mockPsResponse('1 0 0 1024')
    const { collectMemorySnapshot } = await loadCollector()

    const [a, b, c] = await Promise.all([
      collectMemorySnapshot(emptyStore),
      collectMemorySnapshot(emptyStore),
      collectMemorySnapshot(emptyStore)
    ])

    expectProcessSweepCount(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('starts a fresh sweep after the prior one resolves', async () => {
    mockPsResponse('1 0 0 1024')
    const { collectMemorySnapshot } = await loadCollector()

    await collectMemorySnapshot(emptyStore)
    await collectMemorySnapshot(emptyStore)

    expectProcessSweepCount(2)
  })

  it('uses host process RSS for Electron app metrics when available', async () => {
    mockPsResponse(['10 1 1.5 111', '20 10 2.5 222', '30 10 3.5 333'].join('\n'))
    appMetricsMock.mockReturnValue([
      {
        pid: 10,
        type: 'Browser',
        cpu: { percentCPUUsage: 1.5 },
        memory: { workingSetSize: 9999 }
      },
      {
        pid: 20,
        type: 'Renderer',
        cpu: { percentCPUUsage: 2.5 },
        memory: { workingSetSize: 9999 }
      },
      {
        pid: 30,
        type: 'Utility',
        cpu: { percentCPUUsage: 3.5 },
        memory: { workingSetSize: 9999 }
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    expect(snap.app.main.memory).toBe(111 * 1024)
    expect(snap.app.renderer.memory).toBe(222 * 1024)
    expect(snap.app.other.memory).toBe(333 * 1024)
    expect(snap.app.memory).toBe((111 + 222 + 333) * 1024)
    expect(snap.totalMemory).toBe((111 + 222 + 333) * 1024)
  })

  it('falls back to Electron working set when a host process row is missing', async () => {
    mockPsResponse('10 1 1.5 111')
    appMetricsMock.mockReturnValue([
      {
        pid: 999,
        type: 'Renderer',
        cpu: { percentCPUUsage: 2 },
        memory: { workingSetSize: 4096 }
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    expect(snap.app.renderer.memory).toBe(4096 * 1024)
    expect(snap.app.memory).toBe(4096 * 1024)
    expect(snap.totalMemory).toBe(4096 * 1024)
  })

  it('attributes a process shared by two PTYs to the first registrant only', async () => {
    mockPsResponse(['100 1 0 1024', '101 100 0 512', '102 100 0 256'].join('\n'))
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-a',
        worktreeId: 'repo-1::/wt/a',
        sessionId: 's-a',
        paneKey: 'p-a',
        pid: 100
      },
      {
        ptyId: 'pty-b',
        worktreeId: 'repo-1::/wt/b',
        sessionId: 's-b',
        paneKey: 'p-b',
        pid: 101
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    const byWt = new Map(snap.worktrees.map((w) => [w.worktreeId, w]))
    const a = byWt.get('repo-1::/wt/a')
    const b = byWt.get('repo-1::/wt/b')

    expect(a?.memory).toBe((1024 + 512 + 256) * 1024)
    expect(b?.memory).toBe(0)
    expect(snap.totalMemory).toBe((1024 + 512 + 256) * 1024)
  })

  it('routes PTYs with no worktreeId into the orphan bucket', async () => {
    mockPsResponse('50 1 0 2048')
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-orphan',
        worktreeId: null,
        sessionId: null,
        paneKey: null,
        pid: 50
      }
    ])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    expect(snap.worktrees).toHaveLength(1)
    expect(snap.worktrees[0].worktreeId).toBe('__orphan__')
    expect(snap.worktrees[0].memory).toBe(2048 * 1024)
  })

  it('returns an empty snapshot when process enumeration fails', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(new Error('process enumeration failed'), { stdout: '' })
    )
    runProcessMock.mockImplementation(() =>
      Promise.resolve({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'process enumeration failed',
        timedOut: false
      })
    )
    listRegisteredPtysMock.mockReturnValue([])

    const { collectMemorySnapshot } = await loadCollector()
    const snap = await collectMemorySnapshot(emptyStore)

    expect(snap.worktrees).toEqual([])
    expect(snap.totalMemory).toBe(0)
  })
})
