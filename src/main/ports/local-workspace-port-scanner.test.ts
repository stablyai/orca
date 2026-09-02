import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import path from 'node:path'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { attributePortToWorkspace, isContainerProcess } from './local-workspace-port-attribution'
import {
  parseLsofListeningOutput,
  parseNetstatListeningOutput,
  parseProcNetTcp
} from './local-workspace-platform-port-scanner'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'
import { PortScanCommandTimeoutError } from './port-scan-command-protocol'

const runPortScanCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./port-scan-command-client', () => ({
  runPortScanCommand: runPortScanCommandMock,
  isPortScanWorkerUnavailableError: () => false
}))

const LSOF_LISTEN_OUTPUT = ['p123', 'cnode', 'n127.0.0.1:5173'].join('\n')

function urlWatcherStub(): { lookup: () => undefined; reconcileScan: Mock } {
  return { lookup: () => undefined, reconcileScan: vi.fn() }
}

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

  it('parses Windows netstat rows without whitespace regex splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const ports = parseNetstatListeningOutput(
      'TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242'
    )
    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()

    expect(ports).toEqual([{ host: '127.0.0.1', port: 3000, pid: 4242 }])
    expect(usedWhitespaceFieldSplit).toBe(false)
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

  it('parses Linux proc rows without whitespace regex splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const ports = parseProcNetTcp(
      [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 12345'
      ].join('\n')
    )
    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()

    expect(ports).toEqual([{ host: '127.0.0.1', port: 3000, inode: 12345 }])
    expect(usedWhitespaceFieldSplit).toBe(false)
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
    const commandPath = path.posix.resolve('/repo/worktrees/feature/node_modules/vite/bin/vite.js')
    const owner = attributePortToWorkspace({ commandLine: `node ${commandPath}` }, worktrees)

    expect(owner).toMatchObject({
      worktreeId: 'repo::/repo/worktrees/feature',
      confidence: 'command'
    })
  })

  it('requires command-line path boundary evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: `node ${path.posix.resolve('/repo/worktrees/feature-other/server.js')}` },
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
    runPortScanCommandMock.mockReset()
  })

  it('normalizes worktree paths once per scan instead of once per port phase', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const win32ResolveSpy = vi.spyOn(path.win32, 'resolve')
    const posixResolveSpy = vi.spyOn(path.posix, 'resolve')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'lsof' && args.includes('-iTCP')) {
        return {
          stdout: ['p123', 'cnode', 'n127.0.0.1:3000', 'p124', 'cnode', 'n127.0.0.1:3001'].join(
            '\n'
          ),
          spawnMs: 5
        }
      }
      if (command === 'lsof') {
        return {
          stdout: ['p123', 'n/repo/service', 'p124', 'n/repo/worktrees/feature/app'].join('\n'),
          spawnMs: 5
        }
      }
      if (command === 'ps') {
        return {
          stdout: [
            '123 node /repo/service/server.js',
            '124 node /repo/worktrees/feature/app/server.js'
          ].join('\n'),
          spawnMs: 5
        }
      }
      return { stdout: '', spawnMs: 5 }
    })

    const scan = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(scan.ports.filter((port) => port.kind === 'workspace')).toHaveLength(2)
    const win32WorktreePathResolveCalls = win32ResolveSpy.mock.calls.filter(
      ([input]) => input === '/repo' || input === '/repo/worktrees/feature'
    )
    const posixWorktreePathResolveCalls = posixResolveSpy.mock.calls.filter(
      ([input]) => input === '/repo' || input === '/repo/worktrees/feature'
    )
    expect(win32WorktreePathResolveCalls).toHaveLength(0)
    expect(posixWorktreePathResolveCalls).toHaveLength(worktrees.length)
  })
})

describe('scanWorkspacePorts command timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  it('returns an unavailable scan when lsof never reports completion', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockRejectedValue(
      new PortScanCommandTimeoutError('lsof timed out after 4000ms')
    )

    await expect(scanWorkspacePorts([], urlWatcherStub())).resolves.toMatchObject({
      platform: 'darwin',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on darwin.'
    })
  })

  it('backs off after a command timeout instead of launching lsof on every scan tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockRejectedValue(
      new PortScanCommandTimeoutError('lsof timed out after 4000ms')
    )

    await expect(scanWorkspacePorts([], urlWatcherStub())).resolves.toMatchObject({
      platform: 'darwin',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on darwin.'
    })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(1)

    const cooldownScans = await Promise.all(
      Array.from({ length: 10 }, () => scanWorkspacePorts([], urlWatcherStub()))
    )

    expect(cooldownScans).toHaveLength(10)
    expect(cooldownScans[0]).toMatchObject({
      platform: 'darwin',
      ports: []
    })
    expect(
      cooldownScans.every((scan) => scan.unavailableReason?.includes('temporarily paused'))
    ).toBe(true)
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(65_001)
    await vi.advanceTimersByTimeAsync(0)
    runPortScanCommandMock.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('-iTCP') ? 'p123\ncnode\nn127.0.0.1:3000' : '',
      spawnMs: 5
    }))

    const recoveredScan = await scanWorkspacePorts([], urlWatcherStub())

    expect(recoveredScan.unavailableReason).toBeUndefined()
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)
  })
})

describe('scanWorkspacePorts with delayed process creation', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  // Regression for #11161: an endpoint-security hook makes CreateProcessW take
  // seconds, so the command's own budget must not be charged for the spawn.
  it('does not report a command timeout when only process creation was delayed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockResolvedValue({ stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 })

    const first = await scanWorkspacePorts([], urlWatcherStub())
    const second = await scanWorkspacePorts([], urlWatcherStub())

    expect(first.unavailableReason).toBeUndefined()
    expect(second.unavailableReason).toBeUndefined()
    expect(first.ports).toHaveLength(1)
  })

  it('skips the optional metadata commands for one cycle after a stalled spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockResolvedValue({ stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 })

    const scan = await scanWorkspacePorts([], urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(1)
    expect(scan.ports).toHaveLength(1)
  })

  // Regression for #11161 review: a metadata-less scan must not be reconciled as
  // "the listener vanished" — that evicts advertised URLs only a PTY can restore.
  it('does not reconcile advertised URLs for a scan that skipped metadata', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockResolvedValue({ stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 })
    const watcher = urlWatcherStub()

    await scanWorkspacePorts(worktrees, watcher)

    expect(watcher.reconcileScan).not.toHaveBeenCalled()
  })

  it('re-probes metadata on the scan after a skip instead of degrading forever', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 }
      }
      if (command === 'lsof') {
        return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 4_200 }
      }
      return { stdout: '123 node /repo/server.js', spawnMs: 4_200 }
    })
    const watcher = urlWatcherStub()

    const skipped = await scanWorkspacePorts(worktrees, watcher)
    const recovered = await scanWorkspacePorts(worktrees, watcher)

    expect(skipped.ports[0]?.kind).toBe('external')
    expect(recovered.ports[0]).toMatchObject({ kind: 'workspace' })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)
    expect(watcher.reconcileScan).toHaveBeenCalledTimes(worktrees.length)
  })

  it('still collects process metadata when process creation was fast', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('-iTCP') ? LSOF_LISTEN_OUTPUT : '',
      spawnMs: 5
    }))

    await scanWorkspacePorts([], urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)
  })

  // Regression for #11161 review: the skip parity is driven by the 30s poller,
  // so a one-shot user action would otherwise land on a random parity.
  it('keeps probing metadata for callers that require attribution', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockStalledDarwinScan()

    const scan = await scanWorkspacePorts(worktrees, urlWatcherStub(), { requireMetadata: true })

    expect(scan.ports[0]).toMatchObject({ kind: 'workspace' })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)
  })

  it('does not let a required-metadata scan reset the background skip parity', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockStalledDarwinScan()

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    await scanWorkspacePorts(worktrees, urlWatcherStub(), { requireMetadata: true })
    await scanWorkspacePorts(worktrees, urlWatcherStub())

    // 1 skipped + 3 required + 3 recovered; a reset parity would skip twice.
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(7)
  })

  // Regression for #11161 review: without carry-forward the panel moves every
  // workspace port into External on each skipped cycle.
  it('carries the previous cycle attribution through a skipped scan', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let listenSpawnMs = 5
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: listenSpawnMs }
      }
      return { stdout: command === 'lsof' ? ['p123', 'n/repo'].join('\n') : '', spawnMs: 5 }
    })

    const full = await scanWorkspacePorts(worktrees, urlWatcherStub())
    listenSpawnMs = 4_200
    const skipped = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(full.ports[0]).toMatchObject({ kind: 'workspace' })
    expect(skipped.ports[0]).toMatchObject({ kind: 'workspace', processName: 'node' })
  })

  it('does not hand carried-forward metadata to a different listener', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let listenOutput = LSOF_LISTEN_OUTPUT
    let listenSpawnMs = 5
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'lsof' && args.includes('-iTCP')) {
        return { stdout: listenOutput, spawnMs: listenSpawnMs }
      }
      return { stdout: command === 'lsof' ? ['p123', 'n/repo'].join('\n') : '', spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    listenOutput = ['p123', 'cnode', 'n127.0.0.1:9999'].join('\n')
    listenSpawnMs = 4_200
    const skipped = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(skipped.ports[0]?.kind).toBe('external')
  })
})

/** Darwin scan where every spawn stalls past the metadata-skip threshold. */
function mockStalledDarwinScan(): void {
  runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'lsof' && args.includes('-iTCP')) {
      return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 }
    }
    if (command === 'lsof') {
      return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 4_200 }
    }
    return { stdout: '123 node /repo/server.js', spawnMs: 4_200 }
  })
}
