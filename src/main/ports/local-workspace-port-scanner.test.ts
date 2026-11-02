import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import path from 'node:path'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as platformScanner from './local-workspace-platform-port-scanner'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'
import { killWorkspacePort } from './workspace-port-ownership'
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
  runPortScanCommand: (command: string, args: string[], operation?: string) =>
    command === '/usr/sbin/netstat'
      ? Promise.resolve({
          stdout:
            'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\ntcp4 0 0 127.0.0.1.5173 *.* LISTEN\n',
          spawnMs: 5
        })
      : runPortScanCommandMock(command, args, operation),
  isPortScanWorkerUnavailableError: () => false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

const LSOF_LISTEN_OUTPUT = ['p123', 'cnode', 'd0x1', 'n127.0.0.1:5173'].join('\n')

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

  it('keeps the socket identity from lsof -F d and tolerates its absence', () => {
    const ports = parseLsofListeningOutput(
      [
        'p123',
        'cnode',
        'f18',
        'd0x469ca588d83e7924',
        'n127.0.0.1:5173',
        'f19',
        'n127.0.0.1:5174',
        'p456',
        'cnginx',
        'n*:8080'
      ].join('\n')
    )

    expect(ports).toEqual([
      {
        pid: 123,
        processName: 'node',
        socketId: '0x469ca588d83e7924',
        host: '127.0.0.1',
        port: 5173
      },
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 5174 },
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
    vi.mocked(realpath).mockReset()
    runPortScanCommandMock.mockReset()
  })

  it.each([10, 100])('bounds %i roots, preserving URLs and fresh Stop', async (count) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-port-alias-')))
    const target = path.join(root, 'project'),
      alias = path.join(root, 'linked')
    const probe = { ...worktrees[0], path: alias }
    const probes = Array.from({ length: count }, (_, index) =>
      index === 0 ? probe : { ...probe, path: `${root}/extra-${index}` }
    )
    const watcher = new AdvertisedUrlWatcher()
    const lookup = vi.mocked(realpath)
    const finish = async <T>(result: Promise<T>, ms = 1000): Promise<T> => {
      await vi.advanceTimersByTimeAsync(ms)
      return result
    }
    vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.spyOn(platformScanner, 'scanPlatformListeningPorts').mockResolvedValue({
      ports: parseLsofListeningOutput(LSOF_LISTEN_OUTPUT).map((port) => ({ ...port, cwd: target })),
      metadataAvailable: true
    })
    const scan = () => scanWorkspacePorts([...probes, ...probes], watcher)
    const stop = () => killWorkspacePort([probe], { pid: 123, port: 5173 })
    const pending = Promise.withResolvers<string>()
    const admission = vi.spyOn(PrioritySemaphore.prototype, 'acquire')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      watcher.bindPty('pty', probe.id)
      watcher.ingest('pty', 'https://localhost:5173/\n')
      expect((await scan()).ports).toMatchObject([{ owner: { worktreeId: probe.id, path: alias } }])
      expect(realpath).toHaveBeenCalledTimes(count + 1)
      vi.useFakeTimers()
      admission.mockClear()
      lookup.mockClear().mockReturnValue(pending.promise)
      expect((await finish(scan())).ports).toMatchObject([{ kind: 'external' }])
      expect(admission).toHaveBeenCalledTimes(2)
      probes.slice(1).forEach((probe) => {
        probe.path += '/gone'
      })
      await finish(Promise.all(Array.from({ length: 30 }, scan)))
      expect(await finish(stop())).toMatchObject({ ok: false })
      pending.resolve(target)
      await vi.advanceTimersByTimeAsync(0)
      expect(realpath).toHaveBeenCalledTimes(2)
      lookup.mockImplementation(
        // ast-grep-ignore: test-no-real-time-wait -- Fake time drives this mock's delay.
        () => new Promise((resolve) => setTimeout(() => resolve(target), 300))
      )
      const recovered = await finish(scanWorkspacePorts([probe], watcher), 300)
      expect(
        recovered.ports.map((port) => (port.kind === 'workspace' ? port.advertisedUrl : undefined))
      ).toEqual(['https://localhost:5173'])
      expect(await finish(stop(), 300)).toEqual({ ok: true })
      lookup.mockImplementationOnce(
        // ast-grep-ignore: test-no-real-time-wait -- Fake time drives this mock's delay.
        () => new Promise((resolve) => setTimeout(() => resolve(target), 300))
      )
      const older = scanWorkspacePorts([probe], watcher)
      await vi.advanceTimersByTimeAsync(0)
      lookup.mockReset()
      await rm(alias)
      await mkdir(`${target}-other`)
      await symlink(`${target}-other`, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const stopping = stop()
      await vi.advanceTimersByTimeAsync(300)
      expect((await older).ports[0]?.kind).toBe('workspace')
      expect(await stopping).toMatchObject({ ok: false })
    } finally {
      pending.resolve(target)
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes worktree paths once per scan instead of once per port phase', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const win32ResolveSpy = vi.spyOn(path.win32, 'resolve')
    const posixResolveSpy = vi.spyOn(path.posix, 'resolve')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return {
          stdout: ['p123', 'cnode', 'n127.0.0.1:3000', 'p124', 'cnode', 'n127.0.0.1:3001'].join(
            '\n'
          ),
          spawnMs: 5
        }
      }
      if (command === '/usr/sbin/lsof') {
        return {
          stdout: ['p123', 'n/repo/service', 'p124', 'n/repo/worktrees/feature/app'].join('\n'),
          spawnMs: 5
        }
      }
      if (command === '/bin/ps') {
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

describe('scanWorkspacePorts lsof flags', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  it('runs both macOS lsof commands without blocking on mounted file systems', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: 'p123\ncnode\nd0x1\nn127.0.0.1:3000\n', spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: 'p123\nfcwd\nn/repo/service\n', spawnMs: 5 }
      }
      return { stdout: '123 node /repo/service/server.js\n', spawnMs: 5 }
    })

    const scan = await scanWorkspacePorts(worktrees, urlWatcherStub())

    const lsofArgs = runPortScanCommandMock.mock.calls
      .filter(([command]) => command === '/usr/sbin/lsof')
      .map(([, args]) => args)
    expect(lsofArgs).toEqual([
      ['-O', '-b', '-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnd'],
      ['-O', '-b', '-w', '-a', '-p', '123', '-d', 'cwd', '-Fn']
    ])
    expect(scan.ports).toEqual([
      expect.objectContaining({
        port: 3000,
        pid: 123,
        owner: expect.objectContaining({ confidence: 'cwd', path: '/repo' })
      })
    ])
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
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPortScanCommandMock.mockRejectedValue(
      new PortScanCommandTimeoutError('lsof timed out after 4000ms')
    )

    await expect(scanWorkspacePorts([], urlWatcherStub())).resolves.toMatchObject({
      platform: 'win32',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on win32.'
    })
  })

  it('backs off after a command timeout instead of launching lsof on every scan tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPortScanCommandMock.mockRejectedValue(
      new PortScanCommandTimeoutError('lsof timed out after 4000ms')
    )

    await expect(scanWorkspacePorts([], urlWatcherStub())).resolves.toMatchObject({
      platform: 'win32',
      ports: [],
      unavailableReason: 'Port scanning is unavailable on win32.'
    })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(1)

    const cooldownScans = await Promise.all(
      Array.from({ length: 10 }, () => scanWorkspacePorts([], urlWatcherStub()))
    )

    expect(cooldownScans).toHaveLength(10)
    expect(cooldownScans[0]).toMatchObject({
      platform: 'win32',
      ports: []
    })
    expect(
      cooldownScans.every((scan) => scan.unavailableReason?.includes('temporarily paused'))
    ).toBe(true)
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(65_001)
    await vi.advanceTimersByTimeAsync(0)
    runPortScanCommandMock.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('-ano') ? 'TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 123' : '',
      spawnMs: 5
    }))

    const recoveredScan = await scanWorkspacePorts([], urlWatcherStub())

    expect(recoveredScan.unavailableReason).toBeUndefined()
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(2)
  })
})

describe('Darwin unavailable attribution', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  it('observes every fresh holder even when it was absent from the earlier listener table', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let holder = 123
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => ({
      stdout: args.includes('-iTCP')
        ? `p${holder}\ncnode\nd0x1\nn127.0.0.1:9999\n`
        : command === '/usr/sbin/lsof'
          ? `p${holder}\nn/repo\n`
          : `${holder} node /repo/server.js\n`,
      spawnMs: 5
    }))
    expect((await scanWorkspacePorts(worktrees, urlWatcherStub())).ports[0]).toMatchObject({
      pid: 123,
      port: 9999,
      kind: 'workspace'
    })
    holder = 456
    expect((await scanWorkspacePorts(worktrees, urlWatcherStub())).ports[0]).toMatchObject({
      pid: 456,
      port: 9999,
      kind: 'workspace'
    })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(6)
    expect(runPortScanCommandMock).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      expect.arrayContaining(['-O', '-iTCP']),
      'attribution'
    )
  })

  it('keeps listener discovery and advertisements while refusing forced ownership', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let blocked = false
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (blocked) {
        throw new PortScanCommandTimeoutError('attribution unavailable')
      }
      return {
        stdout: args.includes('-iTCP')
          ? LSOF_LISTEN_OUTPUT
          : command === '/usr/sbin/lsof'
            ? 'p123\nn/repo\n'
            : '123 node /repo/server.js\n',
        spawnMs: 5
      }
    })
    const watcher = urlWatcherStub()
    expect((await scanWorkspacePorts(worktrees, watcher)).ports[0]?.kind).toBe('workspace')
    watcher.reconcileScan.mockClear()
    blocked = true
    const fallback = await scanWorkspacePorts(worktrees, watcher)
    expect(fallback.ports[0]).toMatchObject({ kind: 'external', port: 5173 })
    expect(fallback.ports[0]?.pid).toBeUndefined()
    expect(watcher.reconcileScan).not.toHaveBeenCalled()
    expect(
      (await scanWorkspacePorts(worktrees, watcher, { requireMetadata: true })).unavailableReason
    ).toBeDefined()
  })
})

describe('scanWorkspacePorts with delayed process creation', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  // EDR spawn delay must not consume the command execution budget (#11161).
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

  // Missing metadata cannot prove listener absence; eviction would lose PTY-only URL evidence (#11161).
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
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 }
      }
      if (command === '/usr/sbin/lsof') {
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

  it('keeps probing metadata for callers that require attribution', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockStalledDarwinScan()

    const scan = await scanWorkspacePorts(worktrees, urlWatcherStub(), { requireMetadata: true })

    expect(scan.ports[0]).toMatchObject({ kind: 'workspace' })
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)
  })

  it('does not let a required-metadata scan reset the background skip parity', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    // Fresh PIDs prevent metadata reuse from hiding whether this cycle probed.
    let listenerPid = 123
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        listenerPid += 1
        return { stdout: `p${listenerPid}\ncnode\nn127.0.0.1:5173`, spawnMs: 4_200 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: [`p${listenerPid}`, 'n/repo'].join('\n'), spawnMs: 4_200 }
      }
      return { stdout: `${listenerPid} node /repo/server.js`, spawnMs: 4_200 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    await scanWorkspacePorts(worktrees, urlWatcherStub(), { requireMetadata: true })
    await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(7)
  })

  it('serves an unchanged listener from remembered metadata instead of re-probing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 5 }
      }
      return { stdout: '123 node /repo/server.js', spawnMs: 5 }
    })

    const first = await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)

    const second = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)
    expect(second.ports).toEqual(first.ports)
  })

  it('re-probes every port of a pid when any one of them needs metadata', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let secondSocket = 'd0xbbbb'
    let cwd = '/repo'
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return {
          stdout: [
            'p123',
            'cnode',
            'f10',
            'd0xaaaa',
            'n127.0.0.1:5173',
            'f11',
            secondSocket,
            'n127.0.0.1:5174'
          ].join('\n'),
          spawnMs: 5
        }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', `n${cwd}`].join('\n'), spawnMs: 5 }
      }
      return { stdout: `123 node ${cwd}/server.js`, spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)

    // One replaced socket invalidates every cached row for the PID; mixed cwd evidence would split ownership.
    secondSocket = 'd0xcccc'
    cwd = '/elsewhere'
    const scan = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(6)
    expect(new Set(scan.ports.map((entry) => entry.kind)).size).toBe(1)
  })

  it('always probes metadata for a requireMetadata scan, even when the cache is warm', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 5 }
      }
      return { stdout: '123 node /repo/server.js', spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)
    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)

    // SIGTERM authorization cannot trust remembered cwd.
    await scanWorkspacePorts(worktrees, urlWatcherStub(), { requireMetadata: true })

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(7)
  })

  it('re-probes absent socket identities and recycled pids', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let processName = 'node'
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: `p123\nc${processName}\nn127.0.0.1:5173`, spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 5 }
      }
      return { stdout: `123 ${processName} /repo/server.js`, spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(3)

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(6)

    processName = 'python3'
    await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(9)
  })

  it('re-probes when the same pid and name listen through a different socket', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let socketId = '0x1'
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: `p123\ncnode\nf18\nd${socketId}\nn127.0.0.1:5173`, spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 5 }
      }
      return { stdout: '123 node /repo/server.js', spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    await scanWorkspacePorts(worktrees, urlWatcherStub())
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)

    // A changed kernel socket detects process restart despite matching PID/name/address.
    socketId = '0x2'
    await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(7)
  })

  it('re-probes a remembered listener every tenth scan so a changed cwd cannot stay stale', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let cwd = '/repo'
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 5 }
      }
      if (command === '/usr/sbin/lsof') {
        return { stdout: ['p123', `n${cwd}`].join('\n'), spawnMs: 5 }
      }
      return { stdout: '123 node server.js', spawnMs: 5 }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    cwd = '/repo/worktrees/feature'
    for (let scan = 2; scan <= 10; scan += 1) {
      const cached = await scanWorkspacePorts(worktrees, urlWatcherStub())
      expect(cached.ports[0]).toMatchObject({ owner: { worktreeId: 'repo::/repo' } })
    }
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(12)

    const reprobed = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(runPortScanCommandMock).toHaveBeenCalledTimes(15)
    expect(reprobed.ports[0]).toMatchObject({
      owner: { worktreeId: 'repo::/repo/worktrees/feature' }
    })
  })

  // Skipped metadata cycles must retain attribution instead of moving workspace ports into External (#11161).
  it('keeps remembered workspace labels on fresh holders through a slow-spawn skip and recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let slow = false
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => ({
      stdout: args.includes('-iTCP')
        ? `${LSOF_LISTEN_OUTPUT}${slow ? '\np456\ncnode\nd0x2\nn127.0.0.1:8080' : ''}`
        : command === '/usr/sbin/lsof'
          ? 'p123\nn/repo\np456\nn/repo\n'
          : '123 node /repo/server.js\n456 node /repo/other.js\n',
      spawnMs: slow ? 4_200 : 5
    }))
    const watcher = urlWatcherStub()
    expect((await scanWorkspacePorts(worktrees, watcher)).ports[0]).toMatchObject({
      pid: 123,
      kind: 'workspace'
    })
    watcher.reconcileScan.mockClear()
    slow = true
    const skipped = await scanWorkspacePorts(worktrees, watcher)
    expect(skipped.ports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: 123,
          kind: 'workspace',
          owner: expect.objectContaining({ worktreeId: 'repo::/repo', confidence: 'cwd' })
        }),
        expect.objectContaining({ pid: 456, port: 8080, kind: 'external' })
      ])
    )
    expect(watcher.reconcileScan).not.toHaveBeenCalled()
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(4)
    const recovered = await scanWorkspacePorts(worktrees, watcher)
    expect(recovered.ports.every((port) => port.kind === 'workspace')).toBe(true)
    expect(recovered.ports).toHaveLength(2)
    expect(watcher.reconcileScan).toHaveBeenCalledTimes(worktrees.length)
    expect(runPortScanCommandMock).toHaveBeenCalledTimes(7)
  })

  it('does not hand carried-forward metadata to a different listener', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let listenOutput = LSOF_LISTEN_OUTPUT
    let listenSpawnMs = 5
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: listenOutput, spawnMs: listenSpawnMs }
      }
      return {
        stdout: command === '/usr/sbin/lsof' ? ['p123', 'n/repo'].join('\n') : '',
        spawnMs: 5
      }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    listenOutput = ['p123', 'cnode', 'n127.0.0.1:9999'].join('\n')
    listenSpawnMs = 4_200
    const skipped = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(skipped.ports[0]?.kind).toBe('external')
  })
})

function mockStalledDarwinScan(): void {
  runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
      return { stdout: LSOF_LISTEN_OUTPUT, spawnMs: 4_200 }
    }
    if (command === '/usr/sbin/lsof') {
      return { stdout: ['p123', 'n/repo'].join('\n'), spawnMs: 4_200 }
    }
    return { stdout: '123 node /repo/server.js', spawnMs: 4_200 }
  })
}
