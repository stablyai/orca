import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncHandlers, invokeHandlers, removeAllListenersMock } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { returnValue?: unknown; sender?: unknown }, args: unknown) => void
  >(),
  invokeHandlers: new Map<string, () => Promise<{ ok: boolean }>>(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: removeAllListenersMock,
    on: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown; sender?: unknown }, args: unknown) => void
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
  setTrustedRendererShutdownCheckpointWebContentsId,
  SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS
} from './renderer-shutdown-checkpoint'

const STAGE_CHANNEL = 'app:stage-before-unload-sync'
const AWAIT_CHANNEL = 'app:await-before-unload-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
    invokeHandlers.clear()
    vi.restoreAllMocks()
    removeAllListenersMock.mockReset()
    setTrustedRendererShutdownCheckpointWebContentsId(42)
  })

  const makeSession = (activeWorktreeId: string) => ({
    activeRepoId: null,
    activeWorktreeId,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  })

  const makeRendererEvent = (id = 42): { returnValue?: unknown; sender: unknown } => ({
    sender: { id, isDestroyed: () => false, getType: () => 'window' }
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
    const event = makeRendererEvent()
    const localSession = makeSession('local-worktree')
    const remoteSession = makeSession('remote-worktree')
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
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(() => {
        throw new Error('disk full')
      }),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: false })
  })

  it('does not queue persistence when staging is incomplete', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    store.updateUI.mockImplementation(() => {
      throw new Error('invalid state')
    })
    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(event.returnValue).toEqual({ ok: false })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: false })
  })

  it('stages synchronously without waiting on the durable write', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {}))
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent()
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

    syncHandlers.get(STAGE_CHANNEL)?.(makeRendererEvent(), { sessions: [], ui: {} })
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

    const event = makeRendererEvent()
    syncHandlers.get(STAGE_CHANNEL)?.(event, { sessions: [], ui: {} })

    expect(event.returnValue).toEqual({ ok: true })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: false })
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
      syncHandlers.get(STAGE_CHANNEL)?.(makeRendererEvent(), { sessions: [], ui: {} })
      const checkpoint = invokeHandlers.get(AWAIT_CHANNEL)?.()

      await vi.advanceTimersByTimeAsync(SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)

      await expect(checkpoint).resolves.toEqual({ ok: false })
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

  it('rejects malformed, unbounded, and untrusted checkpoints before persistence', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const malformedEvent = makeRendererEvent()
    handler?.(malformedEvent, { sessions: 'not-an-array', ui: {} })
    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(malformedEvent.returnValue).toEqual({ ok: false })

    const tooManySessions = Array.from({ length: 129 }, (_, index) => ({
      state: makeSession(`worktree-${index}`)
    }))
    handler?.(malformedEvent, { sessions: tooManySessions, ui: {} })
    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(malformedEvent.returnValue).toEqual({ ok: false })

    const untrustedEvent = makeRendererEvent(41)
    handler?.(untrustedEvent, { sessions: [{ state: makeSession('worktree-1') }], ui: {} })
    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(untrustedEvent.returnValue).toEqual({ ok: false })
  })

  it('skips a malformed partition while persisting the valid ones', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent()
    const validSession = makeSession('worktree-1')
    handler?.(event, {
      sessions: [
        { state: { ...makeSession('worktree-2'), tabsByWorktree: { 'worktree-2': 5 } } },
        { state: { ...makeSession('worktree-3'), terminalLayoutsByTabId: { 'tab-1': 'oops' } } },
        { state: validSession, hostId: 'runtime:host-1' }
      ],
      ui: { activeView: 'settings' }
    })

    // One corrupt slice must not discard the other checkpoints or block quit;
    // the skipped host keeps its last debounced write instead.
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledTimes(1)
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(
      validSession,
      'runtime:host-1'
    )
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('accepts a runtime-host slice that has no tab or layout containers', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent()
    // A host slice carries only the cloned global fields when no tabs or
    // layouts routed to that host — the shape splitWorkspaceSessionByHost
    // emits for a merely-visited SSH/runtime worktree.
    const hostSlice = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null
    }
    handler?.(event, {
      sessions: [
        { state: makeSession('local-worktree') },
        { state: hostSlice, hostId: 'runtime:host-1' }
      ],
      ui: { activeView: 'settings' }
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledTimes(2)
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(
      hostSlice,
      'runtime:host-1'
    )
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('accepts the latest trusted renderer after the main window is recreated', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)
    setTrustedRendererShutdownCheckpointWebContentsId(43)

    const handler = syncHandlers.get(STAGE_CHANNEL)
    const event = makeRendererEvent(43)
    handler?.(event, { sessions: [{ state: makeSession('worktree-1') }], ui: {} })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledTimes(1)
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })
})
