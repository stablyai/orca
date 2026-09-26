import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { returnValue?: unknown }, args: Record<string, unknown>) => void
  >(),
  invokeHandlers: new Map<string, () => Promise<{ ok: boolean }>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, args: Record<string, unknown>) => void
      ) => {
        syncHandlers.set(channel, handler)
      }
    ),
    handle: vi.fn((channel: string, handler: () => Promise<{ ok: boolean }>) => {
      invokeHandlers.set(channel, handler)
    })
  }
}))

import {
  registerRendererShutdownCheckpointHandler,
  SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS
} from './renderer-shutdown-checkpoint'

const AWAIT_CHANNEL = 'app:await-before-unload-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
    invokeHandlers.clear()
    vi.restoreAllMocks()
  })

  it('stages every shutdown mutation before queueing persistence', () => {
    const callOrder: string[] = []
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn((_state, hostId?: string) => {
        callOrder.push(`session:${hostId ?? 'local'}`)
      }),
      updateUI: vi.fn(() => callOrder.push('ui')),
      flushPendingOrThrowAsync: vi.fn(() => {
        callOrder.push('persist')
        return Promise.resolve()
      })
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    expect(handler).toBeDefined()
    const event: { returnValue?: unknown } = {}
    const localSession = { activeWorktreeId: 'local-worktree' }
    const remoteSession = { activeWorktreeId: 'remote-worktree' }
    handler?.(event, {
      sessions: [{ state: localSession }, { state: remoteSession, hostId: 'runtime:host-1' }],
      ui: { activeView: 'settings' }
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenNthCalledWith(
      1,
      localSession,
      undefined
    )
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenNthCalledWith(
      2,
      remoteSession,
      'runtime:host-1'
    )
    expect(store.updateUI).toHaveBeenCalledWith({ activeView: 'settings' })
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    // Why: Store fences the staged generation without draining unrelated live mutations.
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledWith(
      expect.objectContaining({ drainToStableGeneration: false })
    )
    expect(callOrder).toEqual(['session:local', 'session:runtime:host-1', 'ui', 'persist'])
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('reports a staging failure so the renderer can retry', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(() => {
        throw new Error('session serialization failed')
      }),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, {
      sessions: [{ state: { activeWorktreeId: 'local' } }],
      ui: { activeView: 'settings' }
    })

    expect(event.returnValue).toEqual({ ok: false, error: 'session serialization failed' })
  })

  it('does not veto the shutdown checkpoint when UI broadcast fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(() => {
        throw new Error('UI broadcast failed')
      }),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, {
      sessions: [{ state: { activeWorktreeId: 'local' } }],
      ui: { activeView: 'settings' }
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledTimes(1)
    expect(store.updateUI).toHaveBeenCalledTimes(1)
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
    expect(warnSpy).toHaveBeenCalledWith(
      '[app] Failed to update UI state before unload:',
      expect.any(Error)
    )
  })

  it('does not abort staging for remaining hosts when one session host fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const localSession = { activeWorktreeId: 'local' }
    const remoteSession1 = { activeWorktreeId: 'remote-1' }
    const remoteSession2 = { activeWorktreeId: 'remote-2' }

    const stagedHosts: (string | undefined)[] = []
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn((_state, hostId?: string) => {
        stagedHosts.push(hostId)
        if (hostId === 'runtime:failing-host') {
          throw new Error('host offline')
        }
      }),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, {
      sessions: [
        { state: localSession },
        { state: remoteSession1, hostId: 'runtime:failing-host' },
        { state: remoteSession2, hostId: 'runtime:working-host' }
      ],
      ui: { activeView: 'settings' }
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledTimes(3)
    expect(stagedHosts).toEqual([undefined, 'runtime:failing-host', 'runtime:working-host'])
    expect(event.returnValue).toEqual({ ok: false, error: 'host offline' })
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
  })

  it('does not queue persistence when staging is incomplete', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(() => {
        throw new Error('invalid state')
      }),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, {
      sessions: [{ state: { activeWorktreeId: 'local' } }],
      ui: { activeView: 'settings' }
    })

    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(event.returnValue).toEqual({ ok: false, error: 'invalid state' })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({
      ok: false,
      error: 'invalid state'
    })
  })

  it('stages synchronously without waiting on the durable write', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {}))
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: true })
  })

  it('holds the checkpoint open until the durable write settles', async () => {
    let resolveFlush!: () => void
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(
        () =>
          new Promise<void>((next) => {
            resolveFlush = next
          })
      )
    }
    registerRendererShutdownCheckpointHandler(store as never)

    syncHandlers.get('app:stage-before-unload-sync')?.({}, { sessions: [], ui: {} })
    const checkpoint = invokeHandlers.get(AWAIT_CHANNEL)?.()
    let settled: unknown = 'pending'
    void checkpoint?.then((result) => {
      settled = result
    })

    await Promise.resolve()
    expect(settled).toBe('pending')

    resolveFlush()
    await expect(checkpoint).resolves.toEqual({ ok: true })
  })

  it('reports a failed durable write instead of a successful checkpoint', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.reject(new Error('disk full')))
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registerRendererShutdownCheckpointHandler(store as never)

    const event: { returnValue?: unknown } = {}
    syncHandlers.get('app:stage-before-unload-sync')?.(event, { sessions: [], ui: {} })

    expect(event.returnValue).toEqual({ ok: true })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({
      ok: false,
      error: 'disk full'
    })
  })

  it('fails the checkpoint when the durable write outlives its deadline', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(
        (_options: { signal: AbortSignal }) => new Promise<void>(() => {})
      )
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      registerRendererShutdownCheckpointHandler(store as never)
      syncHandlers.get('app:stage-before-unload-sync')?.({}, { sessions: [], ui: {} })
      const checkpoint = invokeHandlers.get(AWAIT_CHANNEL)?.()

      await vi.advanceTimersByTimeAsync(SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)

      await expect(checkpoint).resolves.toEqual({
        ok: false,
        error: 'Timed out persisting staged renderer state'
      })
      expect(store.flushPendingOrThrowAsync.mock.calls[0]?.[0]?.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports success before any checkpoint is staged', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: true })
  })
})
