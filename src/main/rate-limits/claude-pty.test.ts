import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveClaudeCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveClaudeCommandMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: resolveClaudeCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

import { fetchViaPty } from './claude-pty'
import { getActiveHiddenRateLimitPtyCount } from './hidden-pty-cleanup'

function makeDisposable() {
  return { dispose: vi.fn() }
}

type MockTerm = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

function makeMockTerm(): MockTerm & {
  emitData: (data: string) => void
  emitExit: () => void
} {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandler = handler
      return makeDisposable()
    }),
    onExit: vi.fn((handler: () => void) => {
      exitHandler = handler
      return makeDisposable()
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandler?.(data),
    emitExit: () => exitHandler?.()
  }
}

describe('fetchViaPty', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveClaudeCommandMock.mockReturnValue('claude')
  })

  it('disposes node-pty listeners before killing the hidden PTY on timeout', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()
    const killMock = vi.fn()

    spawnMock.mockReturnValue({
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      kill: killMock
    })

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(25_000)
    await resultPromise

    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
  })

  it('injects the configured proxy into the hidden PTY spawn env', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty({
      networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:7890' }
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(spawnMock).toHaveBeenCalled()
    const spawnEnv = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(spawnEnv.HTTP_PROXY).toBe('http://127.0.0.1:7890')

    term.emitExit()
    await resultPromise
  })

  it('spawns the hidden usage PTY in a bounded non-root cwd', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(0)

    const spawnCwd = spawnMock.mock.calls[0]?.[2]?.cwd as string
    expect(spawnCwd).toContain('rate-limit-pty-cwd')
    expect(spawnCwd).not.toBe('/')
    expect(spawnCwd).not.toMatch(/^[A-Za-z]:(?:[\\/])?$/)

    term.emitExit()
    await resultPromise
  })

  it('leaves the spawn env proxy untouched when no proxy is configured', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    const inheritedHttpsProxy = process.env.HTTPS_PROXY

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.HTTPS_PROXY).toBe(inheritedHttpsProxy)

    term.emitExit()
    await resultPromise
  })

  it('exports the configured proxy inside the WSL launch command', async () => {
    // Why: Windows-side spawn env does not cross into the distro, so the proxy
    // must be exported in the bash command for the inner claude to see it.
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty({
      networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:7890' },
      authPreparation: {
        configDir: '/home/u/.claude',
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxConfigDir: '/home/u/.claude',
        envPatch: { CLAUDE_CONFIG_DIR: '/home/u/.claude' },
        stripAuthEnv: false,
        provenance: 'system'
      }
    })
    await vi.advanceTimersByTimeAsync(0)

    const [spawnFile, spawnArgs] = spawnMock.mock.calls[0] as [string, string[]]
    expect(spawnFile).toBe('wsl.exe')
    const bashCommand = spawnArgs.at(-1) as string
    expect(bashCommand).toContain('mkdir -p "$orca_rate_limit_cwd"')
    expect(bashCommand).toContain('cd "$orca_rate_limit_cwd"')
    expect(bashCommand).toContain("export HTTPS_PROXY='http://127.0.0.1:7890'")
    expect(bashCommand).toContain('exec claude')

    term.emitExit()
    await resultPromise
  })

  it('kills and unregisters the hidden PTY when the fetch signal aborts', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    const controller = new AbortController()
    const killMock = term.kill

    const resultPromise = fetchViaPty({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)

    expect(getActiveHiddenRateLimitPtyCount()).toBe(1)

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
  })

  it('clears the startup delay timer when the hidden PTY exits early', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    term.emitExit()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears pending settle timers when the hidden PTY exits after usage output starts', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData('Current session\r12% used\r')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    term.emitExit()

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12
      }
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats Claude 2.1 tabbed /usage session stats as rendered but unavailable', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(term.write).toHaveBeenCalledWith('/usage\r')

    term.emitData(`
      Settings  Status  Config   Usage  Stats

      Session
      Total cost: $0.0000
      Usage: 0 input, 0 output, 0 cache read, 0 cache write
    `)

    await vi.advanceTimersByTimeAsync(8_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      session: null,
      weekly: null,
      error: 'Claude plan usage is unavailable for this Claude CLI session.'
    })
    expect(term.write).not.toHaveBeenCalledWith('\x1b[D\x1b[D')
  })

  it('keeps waiting for plan windows after the Claude 2.1 usage shell renders', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Settings  Status  Config   Usage  Stats
      Session
      Total cost: $0.0000
    `)

    await vi.advanceTimersByTimeAsync(1_000)
    term.emitData('Current session\r12% used\rResets 4:00pm\rCurrent week (all models)\r34% used\r')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12,
        resetDescription: '4:00pm'
      },
      weekly: {
        usedPercent: 34
      },
      error: null
    })
  })

  it('parses the newer Claude weekly limits wording for Fable usage', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    vi.setSystemTime(new Date(2026, 6, 3, 20, 0))

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Current session
      18% remaining
      Resets in 2h 10m

      Weekly limits
      Fable
      42% consumed
      Resets in 3d 2h
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    const result = await resultPromise

    expect(result).toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 82,
        resetsAt: Date.now() + 2 * 60 * 60_000 + 10 * 60_000,
        resetDescription: '2h 10m'
      },
      weekly: null,
      fableWeekly: {
        usedPercent: 42,
        resetsAt: Date.now() + 3 * 24 * 60 * 60_000 + 2 * 60 * 60_000,
        resetDescription: '3d 2h'
      },
      error: null
    })
  })

  it('parses generic weekly and Fable weekly limits as separate windows', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Current session
      18% remaining
      Resets in 2h 10m

      Current week (all models)
      84% left
      Resets in 5d 4h

      Fable
      42% consumed
      Resets in 3d 2h
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 82,
        resetDescription: '2h 10m'
      },
      weekly: {
        usedPercent: 16,
        resetDescription: '5d 4h'
      },
      fableWeekly: {
        usedPercent: 42,
        resetDescription: '3d 2h'
      },
      error: null
    })
  })

  it('parses Claude current-week Fable usage as a distinct weekly window', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    vi.setSystemTime(new Date(2026, 6, 3, 20, 0))

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Current session
      8% used
      Resets 3:39am

      Current week (all models)
      33% used
      Resets Jul 10 at 12:59pm

      Current week (Fable)
      62% used
      Resets Jul10at12:59pm(America/Los_Angeles)
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 8,
        resetDescription: '3:39am'
      },
      weekly: {
        usedPercent: 33,
        resetsAt: new Date(2026, 6, 10, 12, 59).getTime(),
        resetDescription: 'Jul 10 at 12:59pm'
      },
      fableWeekly: {
        usedPercent: 62,
        resetsAt: Date.parse('2026-07-10T19:59:00.000Z'),
        resetDescription: 'Jul 10 at 12:59pm (America/Los_Angeles'
      },
      error: null
    })
  })

  it('does not let an incomplete Fable section consume later usage sections', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Fable
      Usage unavailable

      Current session
      12% used

      Current week (all models)
      84% left
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12
      },
      weekly: {
        usedPercent: 16
      },
      fableWeekly: null,
      error: null
    })
  })

  it('does not treat inline Fable weekly text as a parsed usage label', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Current session
      Fable weekly usage
      42% consumed

      Current week (all models)
      84% left
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: null,
      weekly: {
        usedPercent: 16
      },
      fableWeekly: null,
      error: null
    })
  })

  it('keeps waiting after a bare Fable heading until another usage section renders', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    let settled = false

    const resultPromise = fetchViaPty().finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Plan usage limits

      Fable
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled).toBe(false)

    term.emitData(`
      42% consumed

      Current session
      12% used
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12
      },
      fableWeekly: {
        usedPercent: 42
      },
      error: null
    })
  })

  it('parses 7-day weekly labels without the old Current week heading', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)

    const resultPromise = fetchViaPty()

    await vi.advanceTimersByTimeAsync(2_000)
    term.emitData(`
      Usage

      Current session
      12% used

      7-day
      84% left
      Resets Wed at 9:05 PM
    `)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: {
        usedPercent: 12
      },
      weekly: {
        usedPercent: 16,
        resetDescription: 'Wed at 9:05 PM'
      },
      error: null
    })
  })
})
