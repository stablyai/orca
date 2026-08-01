import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncHandlers, removeAllListenersMock } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { returnValue?: unknown; sender?: unknown }, args: unknown) => void
  >(),
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
    )
  }
}))

import {
  registerRendererShutdownCheckpointHandler,
  setTrustedRendererShutdownCheckpointWebContentsId
} from './renderer-shutdown-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
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

  it('commits every shutdown state mutation before flushing both stores', () => {
    const callOrder: string[] = []
    const store = {
      setWorkspaceSession: vi.fn((_state, hostId?: string) => {
        callOrder.push(`session:${hostId ?? 'local'}`)
      }),
      updateUI: vi.fn(() => callOrder.push('ui')),
      flushOrThrow: vi.fn(() => callOrder.push('flush')),
      flushActiveViewPreferenceOrThrow: vi.fn(() => callOrder.push('active-view'))
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    expect(handler).toBeDefined()
    const event = makeRendererEvent()
    const localSession = makeSession('local-worktree')
    const remoteSession = makeSession('remote-worktree')
    handler?.(event, {
      sessions: [{ state: localSession }, { state: remoteSession, hostId: 'runtime:host-1' }],
      ui: { activeView: 'settings' }
    })

    expect(store.setWorkspaceSession).toHaveBeenNthCalledWith(1, localSession, undefined)
    expect(store.setWorkspaceSession).toHaveBeenNthCalledWith(2, remoteSession, 'runtime:host-1')
    expect(store.updateUI).toHaveBeenCalledWith({ activeView: 'settings' })
    expect(store.flushOrThrow).toHaveBeenCalledTimes(1)
    expect(store.flushActiveViewPreferenceOrThrow).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual([
      'session:local',
      'session:runtime:host-1',
      'ui',
      'flush',
      'active-view'
    ])
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('reports a failed durable checkpoint so the renderer can retry', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(() => {
        throw new Error('disk full')
      }),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    const event = makeRendererEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: false })
  })

  it('still flushes the active-view sidecar when the durable flush throws', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(() => {
        throw new Error('disk full')
      }),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    const event = makeRendererEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(store.flushActiveViewPreferenceOrThrow).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: false })
  })

  it('flushes the durable store even when the active-view flush throws', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(),
      flushActiveViewPreferenceOrThrow: vi.fn(() => {
        throw new Error('disk full')
      })
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    const event = makeRendererEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(store.flushOrThrow).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: false })
  })

  it('rejects malformed, unbounded, and untrusted checkpoints before persistence', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    const malformedEvent = makeRendererEvent()
    handler?.(malformedEvent, { sessions: 'not-an-array', ui: {} })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(malformedEvent.returnValue).toEqual({ ok: false })

    const tooManySessions = Array.from({ length: 129 }, (_, index) => ({
      state: makeSession(`worktree-${index}`)
    }))
    handler?.(malformedEvent, { sessions: tooManySessions, ui: {} })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(malformedEvent.returnValue).toEqual({ ok: false })

    const untrustedEvent = makeRendererEvent(41)
    handler?.(untrustedEvent, { sessions: [{ state: makeSession('worktree-1') }], ui: {} })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
    expect(untrustedEvent.returnValue).toEqual({ ok: false })
  })

  it('skips a malformed partition while persisting the valid ones', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
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
    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(store.setWorkspaceSession).toHaveBeenCalledWith(validSession, 'runtime:host-1')
    expect(store.flushOrThrow).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('accepts a runtime-host slice that has no tab or layout containers', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
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

    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(2)
    expect(store.setWorkspaceSession).toHaveBeenCalledWith(hostSlice, 'runtime:host-1')
    expect(store.flushOrThrow).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('accepts the latest trusted renderer after the main window is recreated', () => {
    const store = {
      setWorkspaceSession: vi.fn(),
      updateUI: vi.fn(),
      flushOrThrow: vi.fn(),
      flushActiveViewPreferenceOrThrow: vi.fn()
    }
    registerRendererShutdownCheckpointHandler(store as never)
    setTrustedRendererShutdownCheckpointWebContentsId(43)

    const handler = syncHandlers.get('app:persist-before-unload-sync')
    const event = makeRendererEvent(43)
    handler?.(event, { sessions: [{ state: makeSession('worktree-1') }], ui: {} })

    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(store.flushOrThrow).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toEqual({ ok: true })
  })
})
