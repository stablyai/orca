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

describe('fetchCodexRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
  })

  it('disposes node-pty listeners before killing the PTY fallback on timeout', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const killMock = vi.fn()

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue({
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      kill: killMock
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(15_000)
    await resultPromise

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
  })

  it('falls back to the PTY status reader when RPC exits before returning usage', async () => {
    const rpcChild = makeRpcChild()
    const ptyHandlers: { onData?: (data: string) => void } = {}

    childSpawnMock.mockReturnValue(rpcChild)
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchCodexRateLimits()
    rpcChild.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    expect(ptySpawnMock).toHaveBeenCalled()
    const onPtyData = ptyHandlers.onData
    if (!onPtyData) {
      throw new Error('PTY data handler was not registered')
    }
    onPtyData('>')
    onPtyData('5h limit: 7%\nWeekly limit: 12%\n')
    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: { usedPercent: 7 },
      weekly: { usedPercent: 12 },
      status: 'ok',
      error: null
    })
  })

  it('does not start the PTY fallback when disabled for background account previews', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    rpcChild.emit('close')
    await vi.advanceTimersByTimeAsync(0)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error'
    })
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('removes RPC listeners when the app-server timeout settles', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: 'RPC timeout'
    })
    expect(rpcChild.kill).toHaveBeenCalledTimes(1)
    expect(rpcChild.stdout.listenerCount('data')).toBe(0)
    expect(rpcChild.stderr.listenerCount('data')).toBe(0)
    expect(rpcChild.listenerCount('error')).toBe(0)
    expect(rpcChild.listenerCount('close')).toBe(0)
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('normalizes Codex RPC remaining-minute windows to fixed display durations', async () => {
    const rpcChild = makeRpcChild()
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
                result: {
                  rateLimits: {
                    primary: { usedPercent: 0, windowDurationMins: 299 },
                    secondary: { usedPercent: 0, windowDurationMins: 10079 }
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.windowMinutes).toBe(10080)
  })

  it('runs rate-limit RPC through WSL when the Codex home is a WSL managed account', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    const rpcChild = makeRpcChild()
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
                result: { rateLimits: { primary: { usedPercent: 11 } } }
              })}\n`
            )
          )
        }, 0)
      }
    })

    try {
      const resultPromise = fetchCodexRateLimits({
        codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\account\\home'
      })
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      await resultPromise

      expect(childSpawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        [
          '-d',
          'Ubuntu',
          '--',
          'bash',
          '-lc',
          "export CODEX_HOME='/home/alice/.local/share/orca/account/home'; exec codex '-s' 'read-only' '-a' 'untrusted' 'app-server'"
        ],
        expect.objectContaining({
          env: expect.not.objectContaining({ CODEX_HOME: expect.anything() })
        })
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('runs rate-limit PTY fallback through WSL when RPC cannot read usage', async () => {
    const originalPlatform = process.platform
    const originalCodexHome = process.env.CODEX_HOME
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.CODEX_HOME = 'C:\\Users\\alice\\.codex'

    const rpcChild = makeRpcChild()
    const ptyHandlers: { onData?: (data: string) => void } = {}
    childSpawnMock.mockReturnValue(rpcChild)
    ptySpawnMock.mockReturnValue({
      onData: vi.fn((callback) => {
        ptyHandlers.onData = callback
        return makeDisposable()
      }),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      kill: vi.fn()
    })

    try {
      const resultPromise = fetchCodexRateLimits({
        codexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\account\\home'
      })
      rpcChild.emit('close')
      await vi.advanceTimersByTimeAsync(0)

      expect(ptySpawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        [
          '-d',
          'Ubuntu',
          '--',
          'bash',
          '-lc',
          "export CODEX_HOME='/home/alice/.local/share/orca/account/home'; exec codex "
        ],
        expect.objectContaining({
          env: expect.not.objectContaining({ CODEX_HOME: expect.anything() })
        })
      )

      const onPtyData = ptyHandlers.onData
      if (!onPtyData) {
        throw new Error('PTY data handler was not registered')
      }
      onPtyData('>')
      onPtyData('5h limit: 17%\nWeekly limit: 23%\n')
      await vi.advanceTimersByTimeAsync(500)

      await expect(resultPromise).resolves.toMatchObject({
        session: { usedPercent: 17 },
        weekly: { usedPercent: 23 },
        status: 'ok'
      })
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = originalCodexHome
      }
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
