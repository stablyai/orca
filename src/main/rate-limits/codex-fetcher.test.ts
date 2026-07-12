import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Default to signed-in so the spawn paths under test still run; the auth gate
// itself is covered by codex-auth-presence.test.ts and the no-auth case below.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { probeCodexAuthPresence } from './codex-auth-presence'
import { getActiveHiddenRateLimitPtyCount } from './hidden-pty-cleanup'

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

function makePtyTerm() {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback
      return makeDisposable()
    }),
    onExit: vi.fn((callback: () => void) => {
      exitHandler = callback
      return makeDisposable()
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandler?.(data),
    emitExit: () => exitHandler?.()
  }
}

describe('fetchCodexRateLimits', () => {
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

  it('does not spawn Codex when the user is not signed in', async () => {
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('absent')

    await expect(fetchCodexRateLimits()).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'unavailable',
      error: 'Codex not signed in'
    })

    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('preserves the aborted result when cancellation lands during the auth check', async () => {
    let resolveAuth!: (presence: 'absent') => void
    vi.mocked(probeCodexAuthPresence).mockReturnValueOnce(
      new Promise<'absent'>((resolve) => {
        resolveAuth = resolve
      })
    )
    const controller = new AbortController()

    const result = fetchCodexRateLimits({ signal: controller.signal })
    controller.abort()
    resolveAuth('absent')

    await expect(result).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it.each([
    ['timeout', 'Timed out while checking Codex sign-in status'],
    ['unavailable', 'Codex sign-in status is unavailable']
  ] as const)(
    'does not report an indeterminate %s probe as signed out',
    async (presence, error) => {
      vi.mocked(probeCodexAuthPresence).mockResolvedValue(presence)

      await expect(fetchCodexRateLimits()).resolves.toMatchObject({
        provider: 'codex',
        status: 'error',
        error
      })
      expect(childSpawnMock).not.toHaveBeenCalled()
      expect(ptySpawnMock).not.toHaveBeenCalled()
    }
  )

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

  it('spawns the RPC rate-limit reader in a bounded non-root cwd', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(0)

    const spawnCwd = childSpawnMock.mock.calls[0]?.[2]?.cwd as string
    expect(spawnCwd).toContain('rate-limit-pty-cwd')
    expect(spawnCwd).not.toBe('/')
    expect(spawnCwd).not.toMatch(/^[A-Za-z]:\\?$/)

    rpcChild.emit('close')
    await resultPromise
  })

  it('spawns the PTY fallback in a bounded non-root cwd', async () => {
    const term = makePtyTerm()
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue(term)

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    const spawnCwd = ptySpawnMock.mock.calls[0]?.[2]?.cwd as string
    expect(spawnCwd).toContain('rate-limit-pty-cwd')
    expect(spawnCwd).not.toBe('/')
    expect(spawnCwd).not.toMatch(/^[A-Za-z]:\\?$/)

    term.emitExit()
    await resultPromise
  })

  it('kills the RPC child and skips PTY fallback when the fetch signal aborts', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    const controller = new AbortController()

    const resultPromise = fetchCodexRateLimits({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(rpcChild.kill).toHaveBeenCalledTimes(1)
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('kills and unregisters the PTY fallback when the fetch signal aborts', async () => {
    const term = makePtyTerm()
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue(term)
    const controller = new AbortController()
    const killMock = term.kill

    const resultPromise = fetchCodexRateLimits({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)

    expect(getActiveHiddenRateLimitPtyCount()).toBe(1)

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
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
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
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

  it('fills reset-credit count from the backend when the installed app-server omits it', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: 'access-token',
          account_id: 'account-id'
        }
      })
    )
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        available_count: 2,
        total_earned_count: 3,
        credits: [
          {
            status: 'available',
            expires_at: '2026-06-25T12:00:00Z',
            granted_at: '2026-06-18T12:00:00Z'
          },
          {
            status: 'available',
            expires_at: '2026-06-24T12:00:00Z',
            granted_at: '2026-06-17T12:00:00Z'
          },
          {
            status: 'redeemed',
            expires_at: '2026-06-23T12:00:00Z',
            granted_at: '2026-06-16T12:00:00Z'
          }
        ]
      })
    } as Response)
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
                    primary: { usedPercent: 3 },
                    secondary: { usedPercent: 4 }
                  }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits({ codexHomePath: '/managed/codex-home' })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await resultPromise

    expect(result.rateLimitResetCredits).toEqual({
      availableCount: 2,
      totalEarnedCount: 3,
      nextExpiresAt: Date.parse('2026-06-24T12:00:00Z'),
      credits: [
        {
          status: 'available',
          expiresAt: Date.parse('2026-06-25T12:00:00Z'),
          grantedAt: Date.parse('2026-06-18T12:00:00Z')
        },
        {
          status: 'available',
          expiresAt: Date.parse('2026-06-24T12:00:00Z'),
          grantedAt: Date.parse('2026-06-17T12:00:00Z')
        },
        {
          status: 'redeemed',
          expiresAt: Date.parse('2026-06-23T12:00:00Z'),
          grantedAt: Date.parse('2026-06-16T12:00:00Z')
        }
      ]
    })
    expect(readFileMock).toHaveBeenCalledWith(join('/managed/codex-home', 'auth.json'), 'utf8')
    expect(fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'account-id',
          'OpenAI-Beta': 'codex-1',
          originator: 'Codex Desktop'
        })
      })
    )
  })

  it('uses reset-credit count from newer app-server responses without backend fallback', async () => {
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
                  rateLimits: { primary: { usedPercent: 5 } },
                  rateLimitResetCredits: {
                    availableCount: 1,
                    credits: [
                      {
                        status: 'available',
                        expiresAt: '1719326400',
                        grantedAt: '1718721600000'
                      }
                    ]
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

    expect(result.rateLimitResetCredits).toEqual({
      availableCount: 1,
      nextExpiresAt: 1719326400 * 1000,
      credits: [
        {
          status: 'available',
          expiresAt: 1719326400 * 1000,
          grantedAt: 1718721600000
        }
      ]
    })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
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

      const [spawnFile, spawnArgs, spawnOptions] = childSpawnMock.mock.calls[0]
      expect(spawnFile).toBe('wsl.exe')
      expect(spawnArgs.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'sh', '-c'])
      const shellCommand = spawnArgs.at(-1) as string
      expect(shellCommand).toContain('_orca_wsl_shell=\\$(getent passwd')
      expect(shellCommand).toContain('bash|zsh|ksh|mksh|ash) exec "\\$_orca_wsl_shell" -ilc')
      expect(shellCommand).toContain(
        'exec 3<&0\nexec 4>&1\nexec </dev/null\nexec >/dev/null\n_orca_wsl_shell='
      )
      expect(shellCommand).toContain('mkdir -p "\\$orca_rate_limit_cwd"')
      expect(shellCommand).toContain('cd "\\$orca_rate_limit_cwd"')
      expect(shellCommand).toContain(
        "export CODEX_HOME='\\''/home/alice/.local/share/orca/account/home'\\''"
      )
      expect(shellCommand).toContain(
        "exec codex '\\''-s'\\'' '\\''read-only'\\'' '\\''-a'\\'' '\\''untrusted'\\'' '\\''app-server'\\'' <&3 >&4 3<&- 4>&-"
      )
      expect(shellCommand.match(/<&3 >&4 3<&- 4>&-/g)).toHaveLength(3)
      expect(shellCommand.match(/exec codex [^\n]+<&3 >&4 3<&- 4>&-/g)).toHaveLength(3)
      expect(shellCommand).not.toContain('_orca_codex')
      expect(shellCommand).not.toContain('wsl-codex-path')
      expect(spawnOptions).toEqual(
        expect.objectContaining({
          cwd: expect.stringContaining('rate-limit-pty-cwd'),
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

  it('routes Windows host Codex homes through the host RPC path', async () => {
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
                result: { rateLimits: { primary: { usedPercent: 13 } } }
              })}\n`
            )
          )
        }, 0)
      }
    })

    try {
      const resultPromise = fetchCodexRateLimits({ codexHomePath: 'C:\\Users\\alice\\.codex' })
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      await resultPromise

      const [spawnFile, spawnArgs, spawnOptions] = childSpawnMock.mock.calls[0]
      expect(spawnFile).toBe('codex')
      expect(spawnArgs).toEqual(['-s', 'read-only', '-a', 'untrusted', 'app-server'])
      expect(spawnOptions).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ CODEX_HOME: 'C:\\Users\\alice\\.codex' })
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
      await vi.advanceTimersByTimeAsync(0)
      rpcChild.emit('close')
      await vi.advanceTimersByTimeAsync(0)

      const [spawnFile, spawnArgs, spawnOptions] = ptySpawnMock.mock.calls[0]
      expect(spawnFile).toBe('wsl.exe')
      expect(spawnArgs.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'sh', '-c'])
      const shellCommand = spawnArgs.at(-1) as string
      expect(shellCommand).toContain('_orca_wsl_shell=\\$(getent passwd')
      expect(shellCommand).toContain('bash|zsh|ksh|mksh|ash) exec "\\$_orca_wsl_shell" -ilc')
      expect(shellCommand).not.toContain('exec 3<&0')
      expect(shellCommand).not.toContain('exec </dev/null')
      expect(shellCommand).not.toContain('exec >/dev/null')
      expect(shellCommand).not.toContain('<&3 >&4 3<&- 4>&-')
      expect(shellCommand).toContain('mkdir -p "\\$orca_rate_limit_cwd"')
      expect(shellCommand).toContain('cd "\\$orca_rate_limit_cwd"')
      expect(shellCommand).toContain(
        "export CODEX_HOME='\\''/home/alice/.local/share/orca/account/home'\\''"
      )
      expect(shellCommand).toContain('exec codex ')
      expect(shellCommand).not.toContain('_orca_codex')
      expect(shellCommand).not.toContain('wsl-codex-path')
      expect(spawnOptions).toEqual(
        expect.objectContaining({
          cwd: expect.stringContaining('rate-limit-pty-cwd'),
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
