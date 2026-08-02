import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, ptySpawnMock, resolveCodexCommandMock, readFileMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  ptySpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: vi.fn(() => 'present') }))

import { fetchCodexRateLimits } from './codex-fetcher'

const proxyEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
] as const
const originalProxyEnv = Object.fromEntries(
  proxyEnvKeys.map((key) => [key, process.env[key]])
) as Record<(typeof proxyEnvKeys)[number], string | undefined>

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.kill = vi.fn()
  return child
}

function makePtyTerm() {
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: () => void) => {
      exitHandler = callback
      return { dispose: vi.fn() }
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitExit: () => exitHandler?.()
  }
}

describe('Codex rate-limit proxy subprocess environments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
  })

  afterEach(() => {
    for (const key of proxyEnvKeys) {
      const value = originalProxyEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    vi.useRealTimers()
  })

  it('merges configured proxy values over inherited RPC environment values', async () => {
    process.env.HTTP_PROXY = 'http://parent.example:8080'
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({
      allowPtyFallback: false,
      networkProxySettings: {
        httpProxyUrl: 'http://configured.example:9090',
        httpProxyBypassRules: 'localhost, *.internal'
      }
    })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv).toMatchObject({
      HTTP_PROXY: 'http://configured.example:9090',
      HTTPS_PROXY: 'http://configured.example:9090',
      ALL_PROXY: 'http://configured.example:9090',
      http_proxy: 'http://configured.example:9090',
      https_proxy: 'http://configured.example:9090',
      all_proxy: 'http://configured.example:9090',
      NO_PROXY: 'localhost,*.internal',
      no_proxy: 'localhost,*.internal'
    })
    expect(spawnEnv.PATH).toBe(process.env.PATH)
    expect(process.env.HTTP_PROXY).toBe('http://parent.example:8080')

    rpcChild.emit('close')
    await resultPromise
  })

  it('preserves inherited proxy values and does not inject empty config', async () => {
    process.env.HTTP_PROXY = 'http://parent.example:8080'
    delete process.env.NO_PROXY
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({
      allowPtyFallback: false,
      networkProxySettings: { httpProxyUrl: '' }
    })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.HTTP_PROXY).toBe('http://parent.example:8080')
    expect(spawnEnv.NO_PROXY).toBeUndefined()
    expect(process.env.HTTP_PROXY).toBe('http://parent.example:8080')

    rpcChild.emit('close')
    await resultPromise
  })

  it('passes configured proxy values to the PTY child environment', async () => {
    const term = makePtyTerm()
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue(term)

    const resultPromise = fetchCodexRateLimits({
      networkProxySettings: { httpProxyUrl: 'http://configured.example:9090' }
    })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = ptySpawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv).toMatchObject({
      HTTP_PROXY: 'http://configured.example:9090',
      HTTPS_PROXY: 'http://configured.example:9090',
      ALL_PROXY: 'http://configured.example:9090',
      TERM: 'xterm-256color'
    })

    term.emitExit()
    await resultPromise
  })
})
