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
  codexAuthExists: vi.fn(() => true)
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('fetchCodexRateLimits PTY settle timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
  })

  it('coalesces the PTY fallback status settle timer while output keeps streaming', async () => {
    const ptyHandlers: { onData?: (data: string) => void } = {}

    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
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

    const onPtyData = ptyHandlers.onData
    if (!onPtyData) {
      throw new Error('PTY data handler was not registered')
    }

    onPtyData('>')
    expect(vi.getTimerCount()).toBe(1)

    onPtyData('5h limit: 17%\n')
    onPtyData('Weekly limit: 23%\n')
    onPtyData('still rendering\n')
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toMatchObject({
      session: { usedPercent: 17 },
      weekly: { usedPercent: 23 },
      status: 'ok'
    })
  })
})
