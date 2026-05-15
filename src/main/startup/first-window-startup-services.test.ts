import { describe, expect, it, vi } from 'vitest'
import {
  FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS,
  startFirstWindowStartupServices
} from './first-window-startup-services'

describe('startFirstWindowStartupServices', () => {
  it('starts daemon and hook services concurrently before awaiting either', async () => {
    const events: string[] = []
    let resolveDaemon!: () => void
    let resolveHooks!: () => void

    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider: () =>
        new Promise<void>((resolve) => {
          events.push('daemon-started')
          resolveDaemon = resolve
        }),
      startAgentHookServer: () =>
        new Promise<void>((resolve) => {
          events.push('hooks-started')
          resolveHooks = resolve
        }),
      onDaemonError: vi.fn(),
      onAgentHookServerError: vi.fn()
    })

    await Promise.resolve()
    expect(events).toEqual(['daemon-started', 'hooks-started'])

    let completed = false
    started.then(() => {
      completed = true
    })

    resolveDaemon()
    await Promise.resolve()
    expect(completed).toBe(false)

    resolveHooks()
    await started
    expect(completed).toBe(true)
  })

  it('logs each service failure and still resolves the startup barrier', async () => {
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()

    await expect(
      startFirstWindowStartupServices({
        startDaemonPtyProvider: () => Promise.reject(new Error('daemon failed')),
        startAgentHookServer: () => Promise.reject(new Error('hooks failed')),
        onDaemonError,
        onAgentHookServerError
      })
    ).resolves.toBeUndefined()

    expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
    expect(onAgentHookServerError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('fails open when a pre-window startup service hangs', async () => {
    vi.useFakeTimers()
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()

    try {
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: () => new Promise<void>(() => {}),
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError
      })

      await vi.advanceTimersByTimeAsync(FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
      await expect(started).resolves.toBeUndefined()

      expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
      expect(onAgentHookServerError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
