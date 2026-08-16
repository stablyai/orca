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

function mockLinuxProcScan({
  pidCount,
  fdCount,
  firstReadlink
}: {
  pidCount: number
  fdCount: number
  firstReadlink?: Promise<string>
}): void {
  const tcpHeader =
    'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'
  const tcpRow =
    '0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 11111'
  readFileMock.mockImplementation(async (path: string) => {
    if (path === '/proc/net/tcp') {
      return `${tcpHeader}\n${tcpRow}\n`
    }
    if (path === '/proc/net/tcp6') {
      return `${tcpHeader}\n`
    }
    if (path.endsWith('/cmdline')) {
      return '/usr/bin/node\0server.js'
    }
    throw new Error(`unexpected readFile: ${path}`)
  })

  const pids = Array.from({ length: pidCount }, (_, index) => String(1_000 + index))
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
  readlinkMock.mockImplementation(() => {
    if (first && firstReadlink) {
      first = false
      return firstReadlink
    }
    first = false
    return Promise.resolve('socket:[11111]')
  })
}

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
    expect(readdirMock).toHaveBeenNthCalledWith(2, '/proc/1000/fd')
    expect(readlinkMock).toHaveBeenCalledTimes(1)
    expect(readlinkMock).toHaveBeenCalledWith('/proc/1000/fd/0')
  })

  it('preserves detected port results when the request stays live', async () => {
    mockLinuxProcScan({ pidCount: 1, fdCount: 1 })

    await expect(
      capturePortDetectHandler()({}, requestContext(new AbortController().signal))
    ).resolves.toEqual({
      ports: [{ host: '127.0.0.1', port: 3000, pid: 1_000, processName: 'node' }],
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
