import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../../../shared/remote-rpc-content-budget'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file RPC methods', () => {
  it('streams file watch changes until the subscription is cleaned up', async () => {
    vi.useFakeTimers()
    try {
      type WatchCallback = (
        events: { kind: 'update'; absolutePath: string; isDirectory?: boolean }[]
      ) => void
      const watchFileExplorer = vi.fn(async (_worktree: string, _callback: WatchCallback) => {
        return vi.fn()
      })
      const cleanups = new Map<string, () => void>()
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        watchFileExplorer,
        registerSubscriptionCleanup: vi.fn().mockImplementation((id, cleanup) => {
          cleanups.set(id, cleanup)
        })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
      const replies: unknown[] = []

      const dispatch = dispatcher.dispatchStreaming(
        makeRequest('files.watch', { worktree: 'id:wt-1' }),
        (response) => replies.push(JSON.parse(response))
      )

      await vi.waitFor(() => {
        expect(replies).toHaveLength(2)
      })
      expect(runtime.watchFileExplorer).toHaveBeenCalledWith(
        'id:wt-1',
        expect.any(Function),
        expect.any(Function),
        expect.any(AbortSignal)
      )
      expect(replies[0]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'starting', subscriptionId: expect.stringContaining('files-watch-') }
      })
      expect(replies[1]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: expect.stringContaining('files-watch-') }
      })

      const emitWatchChange = watchFileExplorer.mock.calls[0]?.[1]
      expect(emitWatchChange).toBeDefined()
      emitWatchChange?.([{ kind: 'update', absolutePath: '/repo/readme.md', isDirectory: false }])
      emitWatchChange?.([
        { kind: 'update', absolutePath: '/repo/package.json', isDirectory: false }
      ])
      expect(replies).toHaveLength(2)

      await vi.runOnlyPendingTimersAsync()

      expect(replies[2]).toMatchObject({
        ok: true,
        streaming: true,
        result: {
          type: 'changed',
          worktree: 'id:wt-1',
          events: [
            { kind: 'update', absolutePath: '/repo/readme.md', isDirectory: false },
            { kind: 'update', absolutePath: '/repo/package.json', isDirectory: false }
          ]
        }
      })

      const ready = replies[1] as { result: { subscriptionId: string } }
      cleanups.get(ready.result.subscriptionId)?.()
      await dispatch

      expect(replies[3]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a ready file-watch stream when its watcher fails terminally', async () => {
    let onTerminalError: ((error: Error) => void) | undefined
    const unwatch = vi.fn()
    const cleanups = new Map<string, () => void>()
    let emitWatchChange:
      | ((events: { kind: 'overflow'; absolutePath: string }[]) => void)
      | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer: vi.fn(async (_worktree, callback, nextTerminalError) => {
        emitWatchChange = callback
        onTerminalError = nextTerminalError
        return unwatch
      }),
      registerSubscriptionCleanup: vi.fn((id, cleanup) => cleanups.set(id, cleanup)),
      cleanupSubscription: vi.fn((id) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const replies: { result?: { type?: string; message?: string } }[] = []

    const dispatch = dispatcher.dispatchStreaming(
      makeRequest('files.watch', { worktree: 'id:wt-1' }),
      (response) => replies.push(JSON.parse(response))
    )
    await vi.waitFor(() => expect(replies[1]?.result?.type).toBe('ready'))

    emitWatchChange?.([{ kind: 'overflow', absolutePath: '/repo' }])
    onTerminalError?.(new Error('file watcher process crashed repeatedly'))
    await dispatch

    expect(replies.map((reply) => reply.result?.type)).toEqual([
      'starting',
      'ready',
      'changed',
      'error',
      'end'
    ])
    expect(replies[3]?.result?.message).toContain('crashed repeatedly')
    expect(unwatch).toHaveBeenCalledTimes(1)
    expect(cleanups.size).toBe(0)
  })

  it('opens phone and older-CLI files without moving the desktop unless a target asks to', async () => {
    const openMobileFile = vi.fn(async () => ({}))
    const openMobileDiff = vi.fn(async () => ({}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers call only the two open methods and getRuntimeId.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileFile,
      openMobileDiff
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const target = { worktree: 'id:wt-1', relativePath: 'README.md' }

    await dispatcher.dispatch(makeRequest('files.open', target))
    await dispatcher.dispatch(makeRequest('files.openDiff', target))
    await dispatcher.dispatch(makeRequest('files.open', { ...target, navigation: 'all' }))

    expect(openMobileFile.mock.calls).toEqual([
      ['id:wt-1', 'README.md', 'caller'],
      ['id:wt-1', 'README.md', 'all']
    ])
    expect(openMobileDiff.mock.calls).toEqual([['id:wt-1', 'README.md', false, 'caller']])
  })
})
