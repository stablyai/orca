import { afterEach, describe, expect, it, vi } from 'vitest'

import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'

describe('preserveAgentAuthBeforeRestart', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('syncs Codex then Claude before flushing the store', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex')
        }),
        syncActiveWslSelectionsBeforeRestart: vi.fn()
      },
      claudeRuntimeAuth: {
        syncForCurrentSelection: vi.fn(async () => {
          calls.push('claude')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    expect(calls).toEqual(['codex', 'claude', 'flush'])
  })

  it('runs WSL Codex preservation through the runtime service', async () => {
    const syncForCurrentSelection = vi.fn()
    const syncActiveWslSelectionsBeforeRestart = vi.fn()

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection,
        syncActiveWslSelectionsBeforeRestart
      },
      store: {
        flushPendingOrThrowAsync: vi.fn()
      }
    })

    expect(syncForCurrentSelection).toHaveBeenCalledTimes(1)
    expect(syncForCurrentSelection).toHaveBeenNthCalledWith(1)
    expect(syncActiveWslSelectionsBeforeRestart).toHaveBeenCalledTimes(1)
  })

  it('runs Claude preservation before WSL Codex preservation', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex-host')
        }),
        syncActiveWslSelectionsBeforeRestart: vi.fn(() => {
          calls.push('codex-wsl')
        })
      },
      claudeRuntimeAuth: {
        syncForCurrentSelection: vi.fn(async () => {
          calls.push('claude')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    expect(calls).toEqual(['codex-host', 'claude', 'codex-wsl', 'flush'])
  })

  it('continues after WSL Codex preservation fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flushPendingOrThrowAsync = vi.fn()

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(),
        syncActiveWslSelectionsBeforeRestart: vi.fn(() => {
          throw new Error('wsl-token-secret')
        })
      },
      store: {
        flushPendingOrThrowAsync
      }
    })

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-secret')
  })

  it('flushes the store when auth services are missing', async () => {
    const flushPendingOrThrowAsync = vi.fn()

    await preserveAgentAuthBeforeRestart({ store: { flushPendingOrThrowAsync } })

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
  })

  it('logs secret-free warnings and does not throw when sync fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flushPendingOrThrowAsync = vi.fn()

    await expect(
      preserveAgentAuthBeforeRestart({
        codexRuntimeHome: {
          syncForCurrentSelection: vi.fn(() => {
            throw new Error('codex-token-secret')
          }),
          syncActiveWslSelectionsBeforeRestart: vi.fn()
        },
        claudeRuntimeAuth: {
          syncForCurrentSelection: vi.fn(async () => {
            throw new Error('claude-token-secret')
          })
        },
        store: { flushPendingOrThrowAsync }
      })
    ).resolves.toBeUndefined()

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-secret')
  })

  it('releases the lifecycle path on timeout without canceling in-flight sync', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    let finishClaude!: () => void

    const preservation = preserveAgentAuthBeforeRestart({
      claudeRuntimeAuth: {
        syncForCurrentSelection: vi.fn(async () => {
          calls.push('claude-start')
          await new Promise<void>((resolve) => {
            finishClaude = resolve
          })
          calls.push('claude-finish')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await preservation

    expect(calls).toEqual(['claude-start', 'flush'])
    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Claude auth preservation exceeded 2000ms; continuing restart/update'
    )

    finishClaude()
    await Promise.resolve()

    expect(calls).toEqual(['claude-start', 'flush', 'claude-finish'])
  })

  it('bounds a store flush that never settles', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preservation = preserveAgentAuthBeforeRestart({
      store: { flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {})) }
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await preservation

    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Store persistence exceeded 2000ms; continuing restart/update'
    )
  })
})
