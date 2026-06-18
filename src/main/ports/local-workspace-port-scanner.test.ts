import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import {
  attributePortToWorkspace,
  isContainerProcess,
  parseLsofListeningOutput,
  parseNetstatListeningOutput,
  parseProcNetTcp,
  resetWorkspacePortScanTimeoutBackoffForTests,
  scanWorkspacePorts
} from './local-workspace-port-scanner'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

const worktrees = [
  {
    id: 'repo::/repo',
    repoId: 'repo',
    displayName: 'main',
    path: '/repo'
  },
  {
    id: 'repo::/repo/worktrees/feature',
    repoId: 'repo',
    displayName: 'feature',
    path: '/repo/worktrees/feature'
  }
]

describe('local workspace port scanner parsing', () => {
  it('parses lsof field output into listening ports', () => {
    const ports = parseLsofListeningOutput(
      ['p123', 'cnode', 'n127.0.0.1:5173', 'p456', 'cnginx', 'n*:8080'].join('\n')
    )

    expect(ports).toEqual([
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 456, processName: 'nginx', host: '*', port: 8080 }
    ])
  })

  it('parses multiple lsof listening ports for the same process', () => {
    const ports = parseLsofListeningOutput(
      ['p123', 'cnode', 'n127.0.0.1:5173', 'n127.0.0.1:55173'].join('\n')
    )

    expect(ports).toEqual([
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 55173 }
    ])
  })

  it('parses Windows netstat listening rows', () => {
    const ports = parseNetstatListeningOutput(
      [
        'Proto  Local Address          Foreign Address        State           PID',
        'TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
        'TCP    [::]:5173              [::]:0                 LISTENING       5151'
      ].join('\n')
    )

    expect(ports).toEqual([
      { host: '127.0.0.1', port: 3000, pid: 4242 },
      { host: '::', port: 5173, pid: 5151 }
    ])
  })

  it('parses Linux proc tcp listeners', () => {
    const ports = parseProcNetTcp(
      [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 12345 1 0000000000000000 100 0 0 10 0'
      ].join('\n')
    )

    expect(ports).toEqual([{ host: '127.0.0.1', port: 3000, inode: 12345 }])
  })
})

describe('attributePortToWorkspace', () => {
  it('uses cwd ancestry and picks the deepest matching worktree', () => {
    const owner = attributePortToWorkspace(
      { cwd: '/repo/worktrees/feature/packages/app', commandLine: 'node server.js' },
      worktrees
    )

    expect(owner).toMatchObject({
      worktreeId: 'repo::/repo/worktrees/feature',
      displayName: 'feature',
      confidence: 'cwd'
    })
  })

  it('falls back to command-line path evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: 'node /repo/worktrees/feature/node_modules/vite/bin/vite.js' },
      worktrees
    )

    expect(owner).toMatchObject({
      worktreeId: 'repo::/repo/worktrees/feature',
      confidence: 'command'
    })
  })

  it('requires command-line path boundary evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: 'node /repo/worktrees/feature-other/server.js' },
      [worktrees[1]]
    )

    expect(owner).toBeUndefined()
  })

  it('keeps path case significant on case-sensitive platforms', () => {
    const owner = attributePortToWorkspace({ cwd: '/Repo/worktrees/feature' }, worktrees)

    if (process.platform === 'win32') {
      expect(owner).toMatchObject({ worktreeId: 'repo::/repo/worktrees/feature' })
    } else {
      expect(owner).toBeUndefined()
    }
  })

  it('does not guess when there is no worktree evidence', () => {
    const owner = attributePortToWorkspace({ cwd: '/Applications/ContainerRuntime.app' }, worktrees)

    expect(owner).toBeUndefined()
  })
})

describe('container process classification', () => {
  it('detects common container listener owners without workspace attribution', () => {
    expect(isContainerProcess({ processName: 'com.container.backend' })).toBe(true)
    expect(isContainerProcess({ processName: 'com.vendor.backend' })).toBe(true)
    expect(isContainerProcess({ commandLine: '/usr/bin/container-runtime port-forward' })).toBe(
      true
    )
    expect(isContainerProcess({ processName: 'node', commandLine: 'node server.js' })).toBe(false)
  })
})

describe('scanWorkspacePorts attribution work', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    execFileMock.mockReset()
  })

  it('normalizes worktree paths once per scan instead of once per port phase', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const resolveSpy = vi.spyOn(path, 'resolve')
    const posixResolveSpy = vi.spyOn(path.posix, 'resolve')
    const invokeCallback = (callback: unknown, stdout: string): void => {
      if (typeof callback !== 'function') {
        throw new Error('missing execFile callback')
      }
      const execCallback = callback as (error: Error | null, stdout: string) => void
      execCallback(null, stdout)
    }
    execFileMock.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: unknown) => {
        if (command === 'lsof' && args.includes('-iTCP')) {
          invokeCallback(
            callback,
            ['p123', 'cnode', 'n127.0.0.1:3000', 'p124', 'cnode', 'n127.0.0.1:3001'].join('\n')
          )
        } else if (command === 'lsof') {
          invokeCallback(
            callback,
            ['p123', 'n/repo/service', 'p124', 'n/repo/worktrees/feature/app'].join('\n')
          )
        } else if (command === 'ps') {
          invokeCallback(
            callback,
            [
              '123 node /repo/service/server.js',
              '124 node /repo/worktrees/feature/app/server.js'
            ].join('\n')
          )
        } else {
          invokeCallback(callback, '')
        }
        return { kill: vi.fn() }
      }
    )

    const scan = await scanWorkspacePorts(worktrees, {
      lookup: () => undefined,
      reconcileScan: vi.fn()
    })

    expect(scan.ports.filter((port) => port.kind === 'workspace')).toHaveLength(2)
    const worktreePathResolveCalls = resolveSpy.mock.calls.filter(
      ([input]) => input === '/repo' || input === '/repo/worktrees/feature'
    )
    const posixWorktreePathResolveCalls = posixResolveSpy.mock.calls.filter(
      ([input]) => input === '/repo' || input === '/repo/worktrees/feature'
    )
    // Why: POSIX hosts expose path.resolve and path.posix.resolve as the same function.
    if (path.resolve !== path.posix.resolve) {
      expect(worktreePathResolveCalls).toHaveLength(0)
    }
    expect(posixWorktreePathResolveCalls).toHaveLength(worktrees.length)
  })
})

describe('scanWorkspacePorts command timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    execFileMock.mockReset()
  })

  it('returns an unavailable scan when lsof never reports completion', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))

    let settled = false
    const scanPromise = scanWorkspacePorts([], {
      lookup: () => undefined,
      reconcileScan: vi.fn()
    }).then((scan) => {
      settled = true
      return scan
    })

    await vi.advanceTimersByTimeAsync(4_000)

    expect(settled).toBe(true)
    await expect(scanPromise).resolves.toMatchObject({
      platform: 'darwin',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on darwin.'
    })
    expect(killMock).toHaveBeenCalled()
  })

  it('backs off after a command timeout instead of launching lsof on every scan tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))

    const firstScanPromise = scanWorkspacePorts([], {
      lookup: () => undefined,
      reconcileScan: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(4_000)
    await expect(firstScanPromise).resolves.toMatchObject({
      platform: 'darwin',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on darwin.'
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)

    const cooldownScans = await Promise.all(
      Array.from({ length: 10 }, () =>
        scanWorkspacePorts([], {
          lookup: () => undefined,
          reconcileScan: vi.fn()
        })
      )
    )

    expect(cooldownScans).toHaveLength(10)
    expect(cooldownScans[0]).toMatchObject({
      platform: 'darwin',
      ports: []
    })
    expect(
      cooldownScans.every((scan) => scan.unavailableReason?.includes('temporarily paused'))
    ).toBe(true)
    expect(execFileMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(65_001)
    await vi.advanceTimersByTimeAsync(0)
    execFileMock.mockImplementation(
      (_command: string, args: string[], _options: unknown, callback: unknown) => {
        const execCallback = callback as (error: Error | null, stdout: string) => void
        const output = args.includes('-iTCP') ? 'p123\ncnode\nn127.0.0.1:3000' : ''
        execCallback(null, output)
        return { kill: vi.fn() }
      }
    )

    const recoveredScan = await scanWorkspacePorts([], {
      lookup: () => undefined,
      reconcileScan: vi.fn()
    })

    expect(recoveredScan.unavailableReason).toBeUndefined()
    expect(execFileMock).toHaveBeenCalledTimes(4)
  })
})
