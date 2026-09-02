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

    expect(calls).toEqual(['codex', 'claude', 'flush'])
  })

  it('runs Claude preservation after Codex and before the store flush', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex-host')
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

    expect(calls).toEqual(['codex-host', 'claude', 'flush'])
  })

  it('drains retained WSL Codex auth before flushing the store', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex-host')
        }),
        syncActiveWslSelectionsBeforeRestart: vi.fn(async () => {
          calls.push('codex-wsl')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    expect(calls).toEqual(['codex-host', 'codex-wsl', 'flush'])
  })

  it('does not release restart while the bounded WSL drain is still running', async () => {
    vi.useFakeTimers()
    let finishWslDrain!: () => void
    let settled = false
    const flushPendingOrThrowAsync = vi.fn()

    const preservation = preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(),
        syncActiveWslSelectionsBeforeRestart: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishWslDrain = resolve
            })
        )
      },
      store: { flushPendingOrThrowAsync }
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(1)
    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    finishWslDrain()
    await preservation
    expect(settled).toBe(true)
  })

  it('continues after the bounded WSL drain fails without logging secrets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flushPendingOrThrowAsync = vi.fn()

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(),
        syncActiveWslSelectionsBeforeRestart: vi.fn(async () => {
          throw new Error('wsl-token-secret')
        })
      },
      store: { flushPendingOrThrowAsync }
    })

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Codex auth preservation failed (Error); continuing restart/update'
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-secret')
  })

  it('does not start Claude after host Codex exhausts the lifecycle budget', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const syncClaude = vi.fn(async () => {})

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          vi.setSystemTime(startedAt + 2_000)
        })
      },
      claudeRuntimeAuth: { syncForCurrentSelection: syncClaude }
    })

    expect(syncClaude).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Claude auth preservation exceeded 0ms; continuing restart/update'
    )
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
          })
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

  it('shares the original lifecycle timeout between Claude and store preservation', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settled = false

    const preservation = preserveAgentAuthBeforeRestart({
      claudeRuntimeAuth: {
        syncForCurrentSelection: vi.fn(() => new Promise<void>(() => {}))
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {}))
      }
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.runOnlyPendingTimersAsync()
    await preservation

    expect(settled).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      '[agent-auth-restart] Store persistence exceeded 0ms; continuing restart/update'
    )
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
