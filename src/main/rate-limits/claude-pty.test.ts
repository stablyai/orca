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
})
