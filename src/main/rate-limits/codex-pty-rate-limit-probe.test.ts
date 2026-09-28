import { afterEach, describe, expect, it, vi } from 'vitest'
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('./hidden-daemon-pty', () => ({ spawnHiddenDaemonPty: spawnMock }))
import { getActiveHiddenRateLimitPtyCount } from './hidden-pty-cleanup'
import { fetchCodexRateLimitsViaPty } from './codex-pty-rate-limit-probe'

afterEach(() => vi.useRealTimers())

describe('Codex PTY rate-limit probe cancellation', () => {
  it('does not resolve the process command after cancellation', async () => {
    const controller = new AbortController()
    const resolveCommand = vi.fn(() => ({
      command: 'codex',
      args: [],
      cwd: '.',
      env: {}
    }))
    controller.abort()

    await expect(
      fetchCodexRateLimitsViaPty(resolveCommand, { signal: controller.signal })
    ).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(resolveCommand).not.toHaveBeenCalled()
  })

  it('settles a transport failure once and cancels pending status input', async () => {
    vi.useFakeTimers()
    const data = new Set<(value: string) => void>()
    const errors = new Set<(error: Error) => void>()
    const exits = new Set<() => void>()
    const term = {
      pid: 123,
      write: vi.fn(),
      kill: vi.fn(),
      onData: (listener: (value: string) => void) => {
        data.add(listener)
        return { dispose: () => data.delete(listener) }
      },
      onError: (listener: (error: Error) => void) => {
        errors.add(listener)
        return { dispose: () => errors.delete(listener) }
      },
      onExit: (listener: () => void) => {
        exits.add(listener)
        return { dispose: () => exits.delete(listener) }
      }
    }
    spawnMock.mockResolvedValue(term)
    const result = fetchCodexRateLimitsViaPty(() => ({
      command: 'codex',
      args: [],
      cwd: '.',
      env: {}
    }))
    await Promise.resolve()
    for (const listener of data) {
      listener('> ')
    }
    expect(term.write).toHaveBeenCalledExactlyOnceWith('/status')
    for (const listener of errors) {
      listener(new Error('transport unavailable'))
    }
    await expect(result).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      session: null,
      weekly: null,
      error: 'transport unavailable'
    })
    expect(term.kill).toHaveBeenCalledOnce()
    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
    expect([data.size, errors.size, exits.size]).toEqual([0, 0, 0])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(term.write).toHaveBeenCalledOnce()
  })
})
