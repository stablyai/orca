import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('collects and formats memory diagnostics', async () => {
    queueFixtures(
      callMock,
      okFixture('req_memory', {
        app: {
          cpu: 1.25,
          memory: 1024 * 1024,
          main: { cpu: 0.5, memory: 512 * 1024 },
          renderer: { cpu: 0.5, memory: 384 * 1024 },
          other: { cpu: 0.25, memory: 128 * 1024 },
          history: [1024 * 1024]
        },
        worktrees: [
          {
            worktreeId: 'repo::/tmp/repo/feature',
            worktreeName: 'feature',
            repoId: 'repo',
            repoName: 'Orca',
            cpu: 2.5,
            memory: 1024 * 1024,
            sessions: [
              {
                sessionId: 'pty-1',
                paneKey: null,
                pid: 123,
                cpu: 2.5,
                memory: 1024 * 1024
              }
            ],
            history: [1024 * 1024]
          }
        ],
        host: {
          totalMemory: 8 * 1024 * 1024,
          freeMemory: 2 * 1024 * 1024,
          availableMemory: 2 * 1024 * 1024,
          availableMemorySource: 'free-memory',
          usedMemory: 6 * 1024 * 1024,
          memoryUsagePercent: 75,
          cpuCoreCount: 8,
          loadAverage1m: 1.25
        },
        processMemoryMetric: 'rss',
        totalCpu: 3.75,
        totalMemory: 2 * 1024 * 1024,
        collectedAt: 1000
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['diagnostics', 'memory'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('diagnostics.memory')
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('totalMemory: 2.0 MB')
    expect(output).toContain('processMemoryMetric: summed RSS; shared or aliased pages may repeat')
    expect(output).toContain('hostAvailable: 2.0 MB (free-memory)')
    expect(output).toContain('app: 1.0 MB')
    expect(output).toContain('- feature  1.0 MB  2.5%  1 session')
    // Back-compat: a host that never heard of committed bytes prints none.
    expect(output).not.toContain('totalPrivateMemory')
    expect(output).not.toContain('processCommitMetric')
  })

  it('reports committed private bytes alongside the resident figure', async () => {
    queueFixtures(
      callMock,
      okFixture('req_memory', {
        app: {
          cpu: 1.25,
          memory: 1024 * 1024,
          privateMemory: 2 * 1024 * 1024,
          main: { cpu: 0.5, memory: 512 * 1024, privateMemory: 1024 * 1024 },
          renderer: { cpu: 0.5, memory: 384 * 1024, privateMemory: 768 * 1024 },
          other: { cpu: 0.25, memory: 128 * 1024, privateMemory: 256 * 1024 },
          history: [1024 * 1024]
        },
        worktrees: [
          {
            worktreeId: 'repo::/tmp/repo/feature',
            worktreeName: 'feature',
            repoId: 'repo',
            repoName: 'Orca',
            cpu: 2.5,
            memory: 1024 * 1024,
            privateMemory: 14 * 1024 * 1024,
            sessions: [
              {
                sessionId: 'pty-1',
                paneKey: null,
                pid: 123,
                cpu: 2.5,
                memory: 1024 * 1024,
                privateMemory: 14 * 1024 * 1024
              }
            ],
            history: [1024 * 1024]
          }
        ],
        host: {
          totalMemory: 8 * 1024 * 1024,
          freeMemory: 2 * 1024 * 1024,
          availableMemory: 2 * 1024 * 1024,
          availableMemorySource: 'free-memory',
          usedMemory: 6 * 1024 * 1024,
          memoryUsagePercent: 75,
          cpuCoreCount: 8,
          loadAverage1m: 1.25
        },
        processMemoryMetric: 'working-set',
        processCommitMetric: 'private-bytes',
        totalCpu: 3.75,
        totalMemory: 2 * 1024 * 1024,
        totalPrivateMemory: 16 * 1024 * 1024,
        collectedAt: 1000
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['diagnostics', 'memory'], '/tmp/repo')

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('totalMemory: 2.0 MB')
    expect(output).toContain('processMemoryMetric: summed working set; shared pages may repeat')
    expect(output).toContain('totalPrivateMemory: 16 MB')
    expect(output).toContain(
      'processCommitMetric: summed private bytes; committed memory, counted whether resident or paged out'
    )
    expect(output).toContain('- feature  1.0 MB  14 MB committed  2.5%  1 session')
  })

  it('passes committed bytes through --json untouched', async () => {
    const snapshot = {
      app: {
        cpu: 0,
        memory: 1024,
        privateMemory: 4096,
        main: { cpu: 0, memory: 1024, privateMemory: 4096 },
        renderer: { cpu: 0, memory: 0, privateMemory: 0 },
        other: { cpu: 0, memory: 0, privateMemory: 0 },
        history: []
      },
      worktrees: [],
      host: {
        totalMemory: 16 * 1024,
        freeMemory: 1024,
        availableMemory: 1024,
        availableMemorySource: 'free-memory',
        usedMemory: 15 * 1024,
        memoryUsagePercent: 93.75,
        cpuCoreCount: 8,
        loadAverage1m: 0
      },
      processMemoryMetric: 'working-set',
      processCommitMetric: 'private-bytes',
      totalCpu: 0,
      totalMemory: 1024,
      totalPrivateMemory: 4096,
      collectedAt: 1000
    }
    queueFixtures(callMock, okFixture('req_memory', snapshot))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['diagnostics', 'memory', '--json'], '/tmp/repo')

    expect(JSON.parse(logSpy.mock.calls.flat().join('\n')).result).toEqual(snapshot)
  })
})
