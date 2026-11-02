import { afterEach, describe, expect, it, vi } from 'vitest'

import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'

describe('preserveAgentAuthBeforeRestart', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('syncs Codex and flushes the store', async () => {
    const calls: string[] = []

    await preserveAgentAuthBeforeRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: vi.fn(() => {
          calls.push('codex')
        })
      },
      store: {
        flushPendingOrThrowAsync: vi.fn(async () => {
          calls.push('flush')
        })
      }
    })

    expect(calls).toEqual(['codex', 'flush'])
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

  it('checkpoints admitted state without waiting for ongoing edits when auth services are missing', async () => {
    const flushPendingOrThrowAsync = vi.fn()

    await preserveAgentAuthBeforeRestart({ store: { flushPendingOrThrowAsync } })

    expect(flushPendingOrThrowAsync).toHaveBeenCalledExactlyOnceWith({
      drainToStableGeneration: false
    })
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
        store: { flushPendingOrThrowAsync }
      })
    ).resolves.toBeUndefined()

    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-secret')
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
