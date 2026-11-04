import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import os from 'node:os'
import type { MemorySnapshotStore } from './collector'

const MB = 1024 * 1024

const { appMetricsMock, runProcessMock, execMock, listRegisteredPtysMock, helperPresent } =
  vi.hoisted(() => ({
    helperPresent: { value: false },
    appMetricsMock: vi.fn(),
    runProcessMock: vi.fn(),
    execMock: vi.fn(),
    listRegisteredPtysMock: vi.fn()
  }))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: { program: string }) => runProcessMock(spec)
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (path: string) =>
      path.endsWith('orca-process-footprint') ? helperPresent.value : actual.existsSync(path)
  }
})
vi.mock('./pty-registry', () => ({ listRegisteredPtys: listRegisteredPtysMock }))

const emptyStore = {
  getFolderWorkspace: () => undefined,
  getProjectGroups: () => [],
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

async function loadCollector() {
  vi.resetModules()
  const { setAppEnvironment } = await import('../../shared/app-environment')
  setAppEnvironment({
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: appMetricsMock
  })
  const { setLocalDaemonPidReader } = await import('./local-daemon-pid')
  setLocalDaemonPidReader(() => 200)
  return await import('./collector')
}

const TOP_OUTPUT = [
  'Processes: 4 total, 1 running, 3 sleeping, 900 threads',
  'PhysMem: 31G used (3G wired), 1G unused.',
  '',
  'PID    MEM  ',
  '300    2048K',
  '200    30M  ',
  '101    427M+',
  '100    140M '
].join('\n')

describe('darwin memory footprint', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    helperPresent.value = false
    runProcessMock.mockReset()
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    appMetricsMock.mockReturnValue([
      { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } },
      { pid: 101, type: 'GPU', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } }
    ])
    // RSS overstates main (shared framework pages) and understates GPU (no graphics memory).
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, {
        stdout: ['100 1 0 307200', '101 100 0 96256', '200 1 0 71680', '300 200 0 5120'].join('\n')
      })
    )
    runProcessMock.mockImplementation((spec: { program: string }) =>
      Promise.resolve(
        spec.program === '/usr/bin/top'
          ? { code: 0, signal: null, stdout: TOP_OUTPUT, stderr: '', timedOut: false }
          : { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
      )
    )
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'pty-1', worktreeId: 'repo::/repo', sessionId: 's-1', paneKey: null, pid: 300 }
    ])
  })

  it('reports footprint for app processes, counts the detached daemon, and keeps PTYs with worktrees', async () => {
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('footprint')
    expect(snapshot.app.main.memory).toBe(140 * MB)
    expect(snapshot.app.other.memory).toBe((427 + 30) * MB)
    expect(snapshot.worktrees[0].sessions[0].memory).toBe(2 * MB)
    expect(snapshot.totalMemory).toBe((140 + 427 + 30 + 2) * MB)
  })

  it('prefers the bundled helper over top when it is present', async () => {
    helperPresent.value = true
    runProcessMock.mockImplementation((spec: { program: string }) =>
      Promise.resolve(
        spec.program.endsWith('orca-process-footprint')
          ? {
              code: 0,
              signal: null,
              stdout: `100 ${150 * MB}\n101 ${400 * MB}\n`,
              stderr: '',
              timedOut: false
            }
          : { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
      )
    )
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('footprint')
    expect(snapshot.app.main.memory).toBe(150 * MB)
    expect(runProcessMock.mock.calls.map(([spec]) => spec.program)).not.toContain('/usr/bin/top')
  })

  it('falls back to top when the bundled helper fails', async () => {
    helperPresent.value = true
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.app.main.memory).toBe(140 * MB)
  })

  it('falls back to RSS when top is unavailable', async () => {
    runProcessMock.mockRejectedValue(new Error('spawn ENOENT'))
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('rss')
    expect(snapshot.app.main.memory).toBe(300 * MB)
  })
})
