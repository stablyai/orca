import { describe, expect, it, vi } from 'vitest'
import {
  discoverAntigravityLanguageServers,
  parseAntigravityLanguageServerLog,
  type AntigravityLogSource
} from './antigravity-language-server-log'

// Verbatim head of a real `~/.gemini/antigravity-cli/log/cli-*.log` from Antigravity CLI 1.1.21.
const REAL_LOG_HEAD = [
  'ERROR: logging before google.Init: I0826 19:40:33.790434      29 server.go:1485] Starting language server process with pid 82413',
  'ERROR: logging before google.Init: I0826 19:40:33.792836      29 server.go:1538] Language server version: 1.1.21',
  'ERROR: logging before google.Init: I0826 19:40:33.792856      29 server.go:582] Language server will attempt to listen on host localhost',
  'ERROR: logging before google.Init: I0826 19:40:33.794811      29 server.go:597] Language server listening on random port at 61382 for HTTPS (gRPC)',
  'ERROR: logging before google.Init: I0826 19:40:33.795096      29 server.go:605] Language server listening on random port at 61383 for HTTP',
  'ERROR: logging before google.Init: E0826 19:40:34.004211      87 errorreport.go:223] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.'
].join('\n')

function logSource(overrides: Partial<AntigravityLogSource> = {}): AntigravityLogSource {
  return {
    listLogFileNames: vi.fn(async () => []),
    readLogHead: vi.fn(async () => null),
    isProcessAlive: vi.fn(() => true),
    ...overrides
  }
}

describe('parseAntigravityLanguageServerLog', () => {
  it('reads the pid and both loopback ports from a real CLI log head', () => {
    expect(parseAntigravityLanguageServerLog(REAL_LOG_HEAD)).toEqual({
      pid: 82413,
      httpPort: 61383,
      httpsPort: 61382
    })
  })

  // Why: the HTTPS line reads "... for HTTPS (gRPC)" — a prefix match would file it as HTTP
  // and Orca would then send plaintext at a TLS socket on every poll.
  it('does not mistake the HTTPS port for the plaintext port', () => {
    const endpoint = parseAntigravityLanguageServerLog(REAL_LOG_HEAD)

    expect(endpoint?.httpPort).not.toBe(61382)
  })

  it('returns null when no port was logged', () => {
    expect(
      parseAntigravityLanguageServerLog(
        'server.go:1485] Starting language server process with pid 1'
      )
    ).toBeNull()
  })

  it('returns null when no pid was logged', () => {
    expect(
      parseAntigravityLanguageServerLog(
        'server.go:605] Language server listening on random port at 61383 for HTTP'
      )
    ).toBeNull()
  })

  it('rejects an out-of-range port', () => {
    const endpoint = parseAntigravityLanguageServerLog(
      [
        'Starting language server process with pid 5',
        'Language server listening on random port at 99999 for HTTP',
        'Language server listening on random port at 4242 for HTTPS (gRPC)'
      ].join('\n')
    )

    expect(endpoint).toEqual({ pid: 5, httpPort: null, httpsPort: 4242 })
  })
})

describe('discoverAntigravityLanguageServers', () => {
  const newest = 'cli-20260826_194033.log'
  const older = 'cli-20260821_123102.log'

  function headFor(pid: number, port: number): string {
    return [
      `server.go:1485] Starting language server process with pid ${pid}`,
      `server.go:605] Language server listening on random port at ${port} for HTTP`
    ].join('\n')
  }

  // Why: a long-lived `agy` keeps the account it started with across a sign-out, so an older
  // process answers with a stale account's quota. Newest-first is the whole defence (#9122).
  it('orders live servers newest run first regardless of directory order', async () => {
    const endpoints = await discoverAntigravityLanguageServers(
      logSource({
        listLogFileNames: async () => [older, newest],
        readLogHead: async (name) =>
          name === newest ? headFor(82413, 61383) : headFor(70000, 51000)
      })
    )

    expect(endpoints.map((endpoint) => endpoint.pid)).toEqual([82413, 70000])
  })

  it('drops servers whose process has exited', async () => {
    const endpoints = await discoverAntigravityLanguageServers(
      logSource({
        listLogFileNames: async () => [newest, older],
        readLogHead: async (name) =>
          name === newest ? headFor(82413, 61383) : headFor(70000, 51000),
        isProcessAlive: (pid) => pid === 70000
      })
    )

    expect(endpoints.map((endpoint) => endpoint.pid)).toEqual([70000])
  })

  it('ignores files that are not CLI logs', async () => {
    const listLogFileNames = vi.fn(async () => ['cli.log', 'notes.txt', newest])
    const readLogHead = vi.fn(async () => headFor(82413, 61383))

    await discoverAntigravityLanguageServers(logSource({ listLogFileNames, readLogHead }))

    expect(readLogHead).toHaveBeenCalledTimes(1)
    expect(readLogHead).toHaveBeenCalledWith(newest)
  })

  it('reports one endpoint per pid when a process rotated its log', async () => {
    const endpoints = await discoverAntigravityLanguageServers(
      logSource({
        listLogFileNames: async () => [newest, older],
        readLogHead: async () => headFor(82413, 61383)
      })
    )

    expect(endpoints).toHaveLength(1)
  })

  it('returns nothing when the log directory is missing', async () => {
    expect(await discoverAntigravityLanguageServers(logSource())).toEqual([])
  })
})
