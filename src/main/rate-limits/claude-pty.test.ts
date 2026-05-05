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

describe('fetchViaPty', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveClaudeCommandMock.mockReturnValue('claude')
  })

  it('disposes node-pty listeners before killing the hidden PTY on timeout', async () => {
    const onDataDisposable = makeDisposable()
    const onExitDisposable = makeDisposable()

    spawnMock.mockReturnValue({
      onData: vi.fn(() => onDataDisposable),
      onExit: vi.fn(() => onExitDisposable),
      write: vi.fn(),
      kill: vi.fn()
    })

    const resultPromise = fetchViaPty()
    await vi.advanceTimersByTimeAsync(25_000)
    await resultPromise

    const term = spawnMock.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> }
    expect(onDataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      term.kill.mock.invocationCallOrder[0]
    )
    expect(onExitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      term.kill.mock.invocationCallOrder[0]
    )
  })
})
