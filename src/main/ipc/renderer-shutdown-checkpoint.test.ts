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
import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'

const AWAIT_CHANNEL = 'app:await-before-unload-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
    invokeHandlers.clear()
    vi.restoreAllMocks()
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
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: false })
  })
})
