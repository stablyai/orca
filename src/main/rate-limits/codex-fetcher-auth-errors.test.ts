import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

// Auth gate is covered separately; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeDisposable() {
  return { dispose: vi.fn() }
}

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

describe('fetchCodexRateLimits auth errors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
  })

  it('returns Codex RPC auth refresh errors without masking them behind PTY fallback', async () => {
    const rpcChild = makeRpcChild()
    const authError =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'

    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 0)
      }
      if (msg.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: authError }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: authError
    })
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('preserves Codex PTY auth errors when the CLI exits before status is available', async () => {
    const ptyHandlers: { onData?: (data: string) => void; onExit?: () => void } = {}
    const authError =
      'Error loading configuration: Your authentication session could not be refreshed automatically.'

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn((callback) => {
        ptyHandlers.onExit = callback
        return makeDisposable()
      }),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    ptyHandlers.onData?.(`${authError}\n`)
    ptyHandlers.onExit?.()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: authError
    })
  })
})
