import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

type WatchCallback = (events: { kind: 'update'; absolutePath: string }[]) => void

async function startWatch(params: Record<string, unknown>): Promise<{
  replies: { result?: { type?: string } }[]
  emitChange: WatchCallback
}> {
  const watchFileExplorer = vi.fn(async (_worktree: string, _callback: WatchCallback) => vi.fn())
  const fakeRuntime = {
    getRuntimeId: () => 'test-runtime',
    watchFileExplorer,
    registerSubscriptionCleanup: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.watch only touches these three runtime members.
  const runtime = fakeRuntime as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
  const replies: { result?: { type?: string } }[] = []
  void dispatcher.dispatchStreaming(
    { id: 'req-1', authToken: 'tok', method: 'files.watch', params },
    (response) => replies.push(JSON.parse(response))
  )
  await vi.waitFor(() => expect(replies).toHaveLength(2))
  const emitChange = watchFileExplorer.mock.calls[0]?.[1]
  if (!emitChange) {
    throw new Error('watch callback missing')
  }
  return { replies, emitChange }
}

const changedCount = (replies: { result?: { type?: string } }[]): number =>
  replies.filter((reply) => reply.result?.type === 'changed').length

describe('files.watch batch cadence negotiation', () => {
  it('keeps the legacy trailing window for clients that do not ask for the interval cadence', async () => {
    vi.useFakeTimers()
    try {
      const { replies, emitChange } = await startWatch({ worktree: 'id:wt-1' })
      emitChange([{ kind: 'update', absolutePath: '/repo/a.ts' }])
      await vi.advanceTimersByTimeAsync(100)
      expect(changedCount(replies)).toBe(0)
      await vi.advanceTimersByTimeAsync(50)
      expect(changedCount(replies)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the leading flush for clients that opt into the interval cadence', async () => {
    vi.useFakeTimers()
    try {
      const { replies, emitChange } = await startWatch({
        worktree: 'id:wt-1',
        batchCadence: 'interval'
      })
      emitChange([{ kind: 'update', absolutePath: '/repo/a.ts' }])
      await vi.advanceTimersByTimeAsync(100)
      expect(changedCount(replies)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an unknown cadence from a newer client as legacy instead of rejecting', async () => {
    vi.useFakeTimers()
    try {
      const { replies, emitChange } = await startWatch({
        worktree: 'id:wt-1',
        batchCadence: 'future'
      })
      expect(replies[1]?.result?.type).toBe('ready')
      emitChange([{ kind: 'update', absolutePath: '/repo/a.ts' }])
      await vi.advanceTimersByTimeAsync(149)
      expect(changedCount(replies)).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(changedCount(replies)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
