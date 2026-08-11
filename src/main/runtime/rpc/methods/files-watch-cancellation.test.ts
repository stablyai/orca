import { describe, expect, it, vi } from 'vitest'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file watch RPC cancellation', () => {
  it('cancels a file watch waiting for setup before ready', async () => {
    let setupSignal: AbortSignal | undefined
    const watchFileExplorer = vi.fn(
      (
        _worktree: string,
        _callback: (events: unknown[]) => void,
        _onTerminalError: (error: Error) => void,
        signal?: AbortSignal
      ) => {
        setupSignal = signal
        return new Promise<() => void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('setup aborted')), {
            once: true
          })
        })
      }
    )
    const cleanups = new Map<string, () => void | Promise<void>>()
    const cleanupSubscriptionAndWait = vi.fn(async (id: string) => {
      const cleanup = cleanups.get(id)
      await cleanup?.()
      cleanups.delete(id)
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer,
      registerSubscriptionCleanup: vi.fn((id, cleanup) => cleanups.set(id, cleanup)),
      cleanupSubscriptionAndWait,
      cleanupSubscription: vi.fn((id) => {
        void cleanupSubscriptionAndWait(id)
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const replies: { result?: { type?: string; subscriptionId?: string } }[] = []

    const stream = dispatcher.dispatchStreaming(
      makeRequest('files.watch', { worktree: 'id:wt-1' }),
      (response) => replies.push(JSON.parse(response)),
      { connectionId: 'conn-1' }
    )
    await vi.waitFor(() => expect(replies[0]?.result?.type).toBe('starting'))
    const subscriptionId = replies[0]?.result?.subscriptionId
    expect(subscriptionId).toBeTruthy()

    const response = await dispatcher.dispatch(makeRequest('files.unwatch', { subscriptionId }))
    await stream

    expect(response).toMatchObject({ ok: true, result: { unsubscribed: true } })
    expect(setupSignal?.aborted).toBe(true)
    expect(replies.map((reply) => reply.result?.type)).toEqual(['starting', 'end'])
    expect(cleanups.size).toBe(0)
  })

  it('drops queued file watch events when aborted before setup resolves', async () => {
    vi.useFakeTimers()
    try {
      type WatchCallback = (
        events: { kind: 'update'; absolutePath: string; isDirectory?: boolean }[]
      ) => void
      const unwatch = vi.fn()
      let resolveWatch: (value: () => void) => void = () => {}
      const watchFileExplorer = vi.fn((_worktree: string, callback: WatchCallback) => {
        callback([{ kind: 'update', absolutePath: '/repo/queued.ts', isDirectory: false }])
        return new Promise<() => void>((resolve) => {
          resolveWatch = resolve
        })
      })
      const cleanups = new Map<string, () => void | Promise<void>>()
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        watchFileExplorer,
        registerSubscriptionCleanup: vi.fn((id, cleanup) => cleanups.set(id, cleanup)),
        cleanupSubscription: vi.fn((id) => {
          void Promise.resolve(cleanups.get(id)?.())
        })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
      const abortController = new AbortController()
      const replies: unknown[] = []

      const dispatch = dispatcher.dispatchStreaming(
        makeRequest('files.watch', { worktree: 'id:wt-1' }),
        (response) => replies.push(JSON.parse(response)),
        { connectionId: 'conn-1', signal: abortController.signal }
      )
      await vi.waitFor(() => expect(watchFileExplorer).toHaveBeenCalled())

      abortController.abort()
      await dispatch
      await vi.runOnlyPendingTimersAsync()
      resolveWatch(unwatch)
      await vi.waitFor(() => expect(unwatch).toHaveBeenCalled())

      expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledTimes(1)
      expect(replies).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ type: 'starting' }) }),
        expect.objectContaining({ result: { type: 'end' } })
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
