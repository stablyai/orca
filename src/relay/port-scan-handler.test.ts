import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RequestContext } from './dispatcher'

const { readFileMock, readdirMock, readlinkMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readdirMock: vi.fn(),
  readlinkMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  readdir: readdirMock,
  readlink: readlinkMock
}))

import { parseHexAddress, PortScanHandler } from './port-scan-handler'
import { parseWindowsNetstatOutput, parseWindowsPowerShellPortRows } from './windows-port-scan'

// The scanner skips any pid matching the relay process or its parent, so a fixture pid
// range that covers the vitest worker's own pid silently drops the row and the assertion
// sees no ports. Shift the whole range past a colliding pid so the walk stays hermetic.
const MAX_FIXTURE_PIDS = 1_000

const PID_BASE = (() => {
  let base = 1_000
  while ([process.pid, process.ppid].some((pid) => pid >= base && pid < base + MAX_FIXTURE_PIDS)) {
    base += MAX_FIXTURE_PIDS
  }
  return base
})()

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  }
})

function capturePortDetectHandler(): MethodHandler {
  let handler: MethodHandler | undefined
  new PortScanHandler({
    onRequest: (method, nextHandler) => {
      expect(method).toBe('ports.detect')
      handler = nextHandler
    }
  })
  if (!handler) {
    throw new Error('ports.detect handler was not registered')
  }
  return handler
}

function requestContext(signal?: AbortSignal): RequestContext {
  return { clientId: 1, isStale: () => signal?.aborted ?? false, signal }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {
    throw new Error('deferred promise was not initialized')
  }
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

type FixtureListener = { port: number; inode: number }

const DEFAULT_LISTENER: FixtureListener = { port: 3000, inode: 11_111 }

function tcpRow(index: number, { port, inode }: FixtureListener): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  return `${index}: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`
}

function mockLinuxProcScan({
  pidCount,
  fdCount,
  firstReadlink,
  listeners = [DEFAULT_LISTENER],
  inodesByPidOffset,
  cmdlineByPidOffset
}: {
  pidCount: number
  fdCount: number
  firstReadlink?: Promise<string>
  // Listening rows in /proc/net/tcp. Several rows are what makes an early exit keyed on
  // `result.size === inodes.size` distinguishable from one keyed on `result.size > 0`.
  listeners?: readonly FixtureListener[]
  // Socket inode per fd index, keyed by the pid's offset from PID_BASE. Offsets left out hold no
  // listening socket at all; fd indexes past the end of a list link to a non-socket path.
  inodesByPidOffset?: ReadonlyMap<number, readonly number[]>
  cmdlineByPidOffset?: ReadonlyMap<number, string>
}): void {
  const tcpHeader =
    'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'
  readFileMock.mockImplementation(async (path: string) => {
    if (path === '/proc/net/tcp') {
      return `${tcpHeader}\n${listeners.map((listener, index) => tcpRow(index, listener)).join('\n')}\n`
    }
    if (path === '/proc/net/tcp6') {
      return `${tcpHeader}\n`
    }
    const cmdlineMatch = path.match(/^\/proc\/(\d+)\/cmdline$/)
    if (cmdlineMatch) {
      return (
        cmdlineByPidOffset?.get(Number(cmdlineMatch[1]) - PID_BASE) ?? '/usr/bin/node\0server.js'
      )
    }
    throw new Error(`unexpected readFile: ${path}`)
  })

  const pids = Array.from({ length: pidCount }, (_, index) => String(PID_BASE + index))
  const fds = Array.from({ length: fdCount }, (_, index) => String(index))
  readdirMock.mockImplementation(async (path: string) => {
    if (path === '/proc') {
      return pids
    }
    if (path.endsWith('/fd')) {
      return fds
    }
    throw new Error(`unexpected readdir: ${path}`)
  })

  let first = true
  readlinkMock.mockImplementation((path: string) => {
    if (first && firstReadlink) {
      first = false
      return firstReadlink
    }
    first = false
    if (!inodesByPidOffset) {
      return Promise.resolve(`socket:[${DEFAULT_LISTENER.inode}]`)
    }
    const match = path.match(/^\/proc\/(\d+)\/fd\/(\d+)$/)
    if (!match) {
      throw new Error(`unexpected readlink: ${path}`)
    }
    const inode = inodesByPidOffset.get(Number(match[1]) - PID_BASE)?.[Number(match[2])]
    return Promise.resolve(inode === undefined ? '/dev/null' : `socket:[${inode}]`)
  })
}

describe('PortScanHandler Linux walk bounds', () => {
  it('stops walking procfs once every listening socket has an owner', async () => {
    // Why: this scan repeats for the life of the session, and its unit cost was O(all host
    // processes x all fds) regardless of how few sockets it was resolving. On a busy remote the
    // process count only climbs, so the scan got permanently more expensive -- the shape behind
    // "SSH degrades the longer Orca stays open". One listener means one readlink, not 100,000.
    mockLinuxProcScan({ pidCount: 1_000, fdCount: 100 })

    await capturePortDetectHandler()({}, requestContext())

    expect(readlinkMock).toHaveBeenCalledTimes(1)
  })

  it('still walks the whole table when a socket has no reachable owner', async () => {
    // The inverse: an unattributable inode (another user's process) must not make the scan give up
    // early on sockets it could still attribute.
    mockLinuxProcScan({ pidCount: 3, fdCount: 2 })
    readlinkMock.mockImplementation(() => Promise.resolve('socket:[99999]'))

    await capturePortDetectHandler()({}, requestContext())

    expect(readlinkMock).toHaveBeenCalledTimes(6)
  })

  it('resolves an owner for every listening socket before it exits', async () => {
    // The exit condition has to be "every inode is attributed", not "some inode is". With one
    // fixture row those are the same assertion, which is how an exit-after-the-first-listener bug
    // would slip through: ports 3001 and 3002 would come back ownerless.
    mockLinuxProcScan({
      pidCount: 500,
      fdCount: 1,
      listeners: [
        { port: 3000, inode: 11_111 },
        { port: 3001, inode: 22_222 },
        { port: 3002, inode: 33_333 }
      ],
      inodesByPidOffset: new Map([
        [0, [11_111]],
        [1, [22_222]],
        [2, [33_333]]
      ])
    })

    await expect(capturePortDetectHandler()({}, requestContext())).resolves.toEqual({
      platform: 'linux',
      ports: [
        { host: '127.0.0.1', port: 3000, pid: PID_BASE, processName: 'node' },
        { host: '127.0.0.1', port: 3001, pid: PID_BASE + 1, processName: 'node' },
        { host: '127.0.0.1', port: 3002, pid: PID_BASE + 2, processName: 'node' }
      ]
    })
    // Three owners found means three readlinks: it stops at the third pid, not the five hundredth.
    expect(readlinkMock).toHaveBeenCalledTimes(3)
  })

  it('keeps walking past an attributed socket to reach a later owner', async () => {
    // A partially attributed table is the sharpest case: the first pid resolves one inode, and the
    // second inode is only reachable at the end of the walk.
    mockLinuxProcScan({
      pidCount: 4,
      fdCount: 1,
      listeners: [
        { port: 3000, inode: 11_111 },
        { port: 3001, inode: 22_222 }
      ],
      inodesByPidOffset: new Map([
        [0, [11_111]],
        [3, [22_222]]
      ])
    })

    await expect(capturePortDetectHandler()({}, requestContext())).resolves.toEqual({
      platform: 'linux',
      ports: [
        { host: '127.0.0.1', port: 3000, pid: PID_BASE, processName: 'node' },
        { host: '127.0.0.1', port: 3001, pid: PID_BASE + 3, processName: 'node' }
      ]
    })
    expect(readlinkMock).toHaveBeenCalledTimes(4)
  })
})

describe('PortScanHandler shared listening inode attribution', () => {
  it('attributes a shared inode to the first holder the walk reaches', async () => {
    // An nginx master and its workers (or a Node cluster) share one listening inode. The walk used
    // to overwrite the entry for every later holder, so the last pid in readdir order won; exiting
    // as soon as the inode is attributed makes the first one win instead. That is the better
    // answer -- the master owns the socket -- but it is a visible change to the name in the ports
    // UI, so pin it here rather than let it drift.
    mockLinuxProcScan({
      pidCount: 3,
      fdCount: 1,
      inodesByPidOffset: new Map([
        [0, [DEFAULT_LISTENER.inode]],
        [1, [DEFAULT_LISTENER.inode]],
        [2, [DEFAULT_LISTENER.inode]]
      ]),
      cmdlineByPidOffset: new Map([
        [0, '/usr/sbin/nginx\0master process'],
        [1, '/usr/sbin/nginx-worker\0worker process'],
        [2, '/usr/sbin/nginx-worker\0worker process']
      ])
    })

    await expect(capturePortDetectHandler()({}, requestContext())).resolves.toEqual({
      platform: 'linux',
      ports: [{ host: '127.0.0.1', port: 3000, pid: PID_BASE, processName: 'nginx' }]
    })
    expect(readlinkMock).toHaveBeenCalledTimes(1)
  })
})

describe('PortScanHandler Linux cancellation', () => {
  it('does not touch procfs for an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      capturePortDetectHandler()({}, requestContext(controller.signal))
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(readdirMock).not.toHaveBeenCalled()
    expect(readlinkMock).not.toHaveBeenCalled()
  })

  it('stops a large pid and fd walk at the filesystem operation already in flight', async () => {
    const firstReadlink = createDeferred<string>()
    mockLinuxProcScan({ pidCount: 1_000, fdCount: 100, firstReadlink: firstReadlink.promise })
    const controller = new AbortController()
    const scan = capturePortDetectHandler()({}, requestContext(controller.signal))

    await vi.waitFor(() => expect(readlinkMock).toHaveBeenCalledTimes(1))
    controller.abort()
    firstReadlink.resolve('socket:[11111]')

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirMock).toHaveBeenCalledTimes(2)
    expect(readdirMock).toHaveBeenNthCalledWith(1, '/proc')
    expect(readdirMock).toHaveBeenNthCalledWith(2, `/proc/${PID_BASE}/fd`)
    expect(readlinkMock).toHaveBeenCalledTimes(1)
    expect(readlinkMock).toHaveBeenCalledWith(`/proc/${PID_BASE}/fd/0`)
  })

  it('preserves detected port results when the request stays live', async () => {
    mockLinuxProcScan({ pidCount: 1, fdCount: 1 })

    await expect(
      capturePortDetectHandler()({}, requestContext(new AbortController().signal))
    ).resolves.toEqual({
      ports: [{ host: '127.0.0.1', port: 3000, pid: PID_BASE, processName: 'node' }],
      platform: 'linux'
    })
  })
})

describe('parseHexAddress', () => {
  it('parses IPv4 localhost (127.0.0.1)', () => {
    // 127.0.0.1 in little-endian hex: 0100007F
    const result = parseHexAddress('0100007F:0BB8')
    expect(result).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('parses IPv4 all-interfaces (0.0.0.0)', () => {
    const result = parseHexAddress('00000000:1F90')
    expect(result).toEqual({ host: '0.0.0.0', port: 8080 })
  })

  it('parses port 22 correctly', () => {
    const result = parseHexAddress('00000000:0016')
    expect(result).toEqual({ host: '0.0.0.0', port: 22 })
  })

  it('parses port 443 correctly', () => {
    const result = parseHexAddress('0100007F:01BB')
    expect(result).toEqual({ host: '127.0.0.1', port: 443 })
  })

  it('parses a non-localhost IPv4 address', () => {
    // 192.168.1.100 in little-endian: 6401A8C0
    const result = parseHexAddress('6401A8C0:1388')
    expect(result).toEqual({ host: '192.168.1.100', port: 5000 })
  })

  it('parses IPv6 all-zeros (::)', () => {
    const result = parseHexAddress('00000000000000000000000000000000:1F90')
    expect(result).toEqual({ host: '::', port: 8080 })
  })

  it('parses IPv6 loopback (::1)', () => {
    const result = parseHexAddress('00000000000000000000000001000000:0BB8')
    expect(result).toEqual({ host: '::1', port: 3000 })
  })

  it('returns null for port 0', () => {
    const result = parseHexAddress('0100007F:0000')
    expect(result).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseHexAddress('invalid')).toBeNull()
    expect(parseHexAddress('')).toBeNull()
    expect(parseHexAddress('::::')).toBeNull()
  })

  it('parses high ports correctly', () => {
    // Port 65535 = FFFF
    const result = parseHexAddress('0100007F:FFFF')
    expect(result).toEqual({ host: '127.0.0.1', port: 65535 })
  })

  it('parses port 5432 (postgres)', () => {
    const result = parseHexAddress('0100007F:1538')
    expect(result).toEqual({ host: '127.0.0.1', port: 5432 })
  })

  it('parses port 3306 (mysql)', () => {
    const result = parseHexAddress('00000000:0CEA')
    expect(result).toEqual({ host: '0.0.0.0', port: 3306 })
  })
})

describe('parseWindowsPowerShellPortRows', () => {
  it('parses PowerShell JSON arrays', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify([
          { host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' },
          { host: '0.0.0.0', port: 8080, pid: 5678, processName: 'dotnet' }
        ])
      )
    ).toEqual([
      { host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' },
      { host: '0.0.0.0', port: 8080, pid: 5678, processName: 'dotnet' }
    ])
  })

  it('parses single-object PowerShell JSON', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify({ host: '::1', port: '3000', pid: '4321', processName: 'node' })
      )
    ).toEqual([{ host: '::1', port: 3000, pid: 4321, processName: 'node' }])
  })

  it('ignores malformed rows', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify([
          { host: '127.0.0.1', port: 5173, pid: 1234 },
          { host: '127.0.0.1', port: 'nan', pid: 1234 },
          { port: 8080, pid: 5678 }
        ])
      )
    ).toEqual([{ host: '127.0.0.1', port: 5173, pid: 1234 }])
  })
})

describe('parseWindowsNetstatOutput', () => {
  it('parses Windows netstat listening rows', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:9229         0.0.0.0:0              ESTABLISHED     1234',
      '  TCP    [::1]:3000             [::]:0                 LISTENING       5678'
    ].join('\r\n')

    expect(parseWindowsNetstatOutput(output)).toEqual([
      { host: '0.0.0.0', port: 5173, pid: 1234 },
      { host: '::1', port: 3000, pid: 5678 }
    ])
  })

  it('parses Windows netstat rows without whitespace regex splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')

    expect(
      parseWindowsNetstatOutput(
        '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242'
      )
    ).toEqual([{ host: '127.0.0.1', port: 3000, pid: 4242 }])

    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()
    expect(usedWhitespaceFieldSplit).toBe(false)
  })
})
