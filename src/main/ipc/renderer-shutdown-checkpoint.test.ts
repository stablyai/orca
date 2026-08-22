import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (
      event: { sender: { id: number }; returnValue?: unknown },
      args: Record<string, unknown>
    ) => void
  >(),
  invokeHandlers: new Map<string, () => Promise<{ ok: boolean }>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(
      (
        channel: string,
        handler: (
          event: { sender: { id: number }; returnValue?: unknown },
          args: Record<string, unknown>
        ) => void
      ) => {
        syncHandlers.set(channel, handler)
      }
    ),
    handle: vi.fn((channel: string, handler: () => Promise<{ ok: boolean }>) => {
      invokeHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../window/orca-window-manager', () => ({
  orcaWindowManager: {
    getControlWindow: () => ({ id: 1 }),
    getWindowForSender: (sender: { id: number }) =>
      sender.id === 101 ? { id: 1 } : sender.id === 102 ? { id: 2 } : null
  }
}))

import {
  registerRendererShutdownCheckpointHandler,
  SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS
} from './renderer-shutdown-checkpoint'

const AWAIT_CHANNEL = 'app:await-before-unload-checkpoint'
const makeEvent = (): { sender: { id: number }; returnValue?: unknown } => ({
  sender: { id: 101 }
})

function makeSession(tabId: string) {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo',
    activeWorktreeId: 'wt',
    activeTabId: tabId,
    tabsByWorktree: {
      wt: [
        {
          id: tabId,
          worktreeId: 'wt',
          title: tabId,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: `pty-${tabId}`
        }
      ]
    }
  }
}

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
    const event = makeEvent()
    const localSession = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'local-worktree'
    }
    const remoteSession = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'remote-worktree'
    }
    handler?.(event, {
      sessions: [{ state: localSession }, { state: remoteSession, hostId: 'runtime:host-1' }],
      ui: { activeView: 'settings' }
    })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenNthCalledWith(
      1,
      localSession,
      'local'
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

  it('stages a merged snapshot when two Orca windows unload', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })),
      setWorkspaceSession: vi.fn(),
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)
    const handler = syncHandlers.get('app:stage-before-unload-sync')

    handler?.(makeEvent(), { sessions: [{ state: makeSession('tab-a') }], ui: {} })
    handler?.({ sender: { id: 102 } }, { sessions: [{ state: makeSession('tab-b') }], ui: {} })

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabsByWorktree: {
          wt: [expect.objectContaining({ id: 'tab-a' }), expect.objectContaining({ id: 'tab-b' })]
        }
      }),
      'local'
    )
  })

  it('merges each host independently across two window checkpoints', () => {
    const store = {
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)
    const handler = syncHandlers.get('app:stage-before-unload-sync')
    handler?.(makeEvent(), {
      sessions: [
        { state: makeSession('local-a') },
        { state: makeSession('ssh-a'), hostId: 'ssh:server-1' }
      ],
      ui: {}
    })
    handler?.(
      { sender: { id: 102 } },
      {
        sessions: [
          { state: makeSession('local-b') },
          { state: makeSession('ssh-b'), hostId: 'ssh:server-1' }
        ],
        ui: {}
      }
    )

    const [local, localHost] = store.stageWorkspaceSessionBeforeUnload.mock.calls.at(-2)!
    const [ssh, sshHost] = store.stageWorkspaceSessionBeforeUnload.mock.calls.at(-1)!
    expect(localHost).toBe('local')
    expect(local.tabsByWorktree.wt.map((tab: { id: string }) => tab.id)).toEqual([
      'local-a',
      'local-b'
    ])
    expect(sshHost).toBe('ssh:server-1')
    expect(ssh.tabsByWorktree.wt.map((tab: { id: string }) => tab.id)).toEqual(['ssh-a', 'ssh-b'])
  })

  it('fails closed before staging state from an untrusted sender', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registerRendererShutdownCheckpointHandler(store as never)
    const event = { sender: { id: 999 }, returnValue: undefined as unknown }

    syncHandlers.get('app:stage-before-unload-sync')?.(event, {
      sessions: [{ state: makeSession('untrusted') }],
      ui: { activeView: 'settings' }
    })

    expect(event.returnValue).toEqual({ ok: false })
    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    expect(store.updateUI).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
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

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
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
    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
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

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
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

    syncHandlers.get('app:stage-before-unload-sync')?.(makeEvent(), { sessions: [], ui: {} })
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

    const event = makeEvent()
    syncHandlers.get('app:stage-before-unload-sync')?.(event, { sessions: [], ui: {} })

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
      syncHandlers.get('app:stage-before-unload-sync')?.(makeEvent(), { sessions: [], ui: {} })
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
})
