import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { returnValue?: unknown }, args: Record<string, unknown>) => void
  >()
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
    )
  }
}))

import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
  })

  it('stages every shutdown mutation before queueing persistence', () => {
    const callOrder: string[] = []
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn((_state, hostId?: string) => {
        callOrder.push(`session:${hostId ?? 'local'}`)
      }),
      updateUI: vi.fn(() => callOrder.push('ui')),
      flushPendingAsync: vi.fn(() => {
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
    expect(store.flushPendingAsync).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['session:local', 'session:runtime:host-1', 'ui', 'persist'])
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('reports a staging failure so the renderer can retry', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(() => {
        throw new Error('disk full')
      }),
      flushPendingAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: false })
  })

  it('does not queue persistence when staging is incomplete', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    store.updateUI.mockImplementation(() => {
      throw new Error('invalid state')
    })
    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(store.flushPendingAsync).not.toHaveBeenCalled()
    expect(event.returnValue).toEqual({ ok: false })
  })

  it('returns before the asynchronous persistence settles', () => {
    let resolve!: () => void
    const pending = new Promise<void>((next) => {
      resolve = next
    })
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingAsync: vi.fn(() => pending)
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event: { returnValue?: unknown } = {}
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: true })
    resolve()
  })
})
