import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

// Auth gate is covered by codex-auth-presence.test.ts; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { probeCodexAuthPresence } from './codex-auth-presence'

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
  }
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  child.exitCode = null
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  return child
}

function respondToRpcRateLimitRead(
  rpcChild: ReturnType<typeof makeRpcChild>,
  rateLimits: unknown
): void {
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
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { rateLimits } })}\n`)
        )
      }, 0)
    }
  })
}

describe('fetchCodexRateLimits probe shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('present')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gives a cold app-server the full boot budget before any deadline fires', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        // Why: cold starts (auth refresh included) are documented at 10-25s;
        // the old 10s deadline killed them mid-auth.
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 20_000)
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
                  rateLimits: { primary: { usedPercent: 3 }, secondary: { usedPercent: 4 } }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(rpcChild.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    await expect(resultPromise).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 3 },
      weekly: { usedPercent: 4 }
    })
  })

  it('arms the read deadline after initialize and drains SIGTERM before SIGKILL', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const rpcChild = makeRpcChild()
    // Stubborn child: it ignores stdin EOF, survives SIGTERM, dies on SIGKILL.
    rpcChild.stdin.end = vi.fn()
    rpcChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        rpcChild.exitCode = 0
        rpcChild.emit('exit', 0, null)
      }
      return true
    })
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
      // The rate-limits read never answers, so the request deadline expires.
    })

    try {
      const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(rpcChild.kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(rpcChild.stdin.end).toHaveBeenCalledTimes(1)
      expect(rpcChild.kill).toHaveBeenCalledWith('SIGTERM')
      expect(rpcChild.kill).not.toHaveBeenCalledWith('SIGKILL')

      await vi.advanceTimersByTimeAsync(5_000)
      expect(rpcChild.kill).toHaveBeenCalledWith('SIGKILL')
      await expect(resultPromise).resolves.toMatchObject({
        status: 'error',
        error: 'RPC timeout'
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not spawn a second probe for the same home while one is still running', async () => {
    const firstChild = makeRpcChild()
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    const first = fetchCodexRateLimits({
      allowPtyFallback: false,
      codexHomePath: '/managed/home-a'
    })
    await vi.advanceTimersByTimeAsync(0)
    const second = fetchCodexRateLimits({
      allowPtyFallback: false,
      codexHomePath: '/managed/home-a'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(childSpawnMock).toHaveBeenCalledTimes(1)

    firstChild.emit('close')
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(childSpawnMock).toHaveBeenCalledTimes(2)
    await expect(second).resolves.toMatchObject({ status: 'ok' })
    await first
  })

  it('keeps the home lock through child errors until the failed probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: '/managed/home-error'
      })
      await vi.advanceTimersByTimeAsync(0)
      firstChild.emit('error', new Error('stdio failed'))
      const second = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: '/managed/home-error'
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'stdio failed' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it.each([
    { failAt: 1, phase: 'initial request' },
    { failAt: 2, phase: 'initialized notification' },
    { failAt: 3, phase: 'rate-limit request' }
  ])('keeps the home lock when the $phase stdin write throws', async ({ failAt, phase }) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    let writeCount = 0
    firstChild.stdin.write.mockImplementation((line: string) => {
      writeCount += 1
      if (writeCount === failAt) {
        throw new Error(`${phase} stdin failed`)
      }
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          firstChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
    })
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })
    const home = `/managed/home-stdin-error-${failAt}`

    try {
      const first = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: home
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')

      const second = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: home
      })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({
        status: 'error',
        error: `${phase} stdin failed`
      })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('observes asynchronous stdin failures and keeps the lock until the probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: '/managed/home-async-stdin-error'
      })
      await vi.advanceTimersByTimeAsync(0)
      firstChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      const second = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: '/managed/home-async-stdin-error'
      })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'write EPIPE' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
