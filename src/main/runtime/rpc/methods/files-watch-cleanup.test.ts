import { expect, it, vi } from 'vitest'
import { WatcherProcessFailure } from '../../../ipc/parcel-watcher-process-failure'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

it.each(['late', 'already-resolved', 'transient'] as const)(
  'retries retained file-watch cleanup after %s failure',
  async (failureTiming) => {
    let resolvePhysicalExit: () => void = () => {}
    const physicalExit =
      failureTiming === 'already-resolved'
        ? Promise.resolve()
        : failureTiming === 'late'
          ? new Promise<void>((resolve) => {
              resolvePhysicalExit = resolve
            })
          : undefined
    const cleanupError = physicalExit
      ? new WatcherProcessFailure(
          'file watcher process did not exit after termination deadline',
          'supervisor',
          'process_unavailable',
          physicalExit
        )
      : new Error('transient unwatch failure')
    const unwatch = vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValue(undefined)
    let cleanup: (() => Promise<void>) | undefined
    let subscriptionId = ''
    let inFlight: Promise<void> | null = null
    const cleanupSubscriptionAndWait = vi.fn(() => {
      if (inFlight) {
        return inFlight
      }
      let tracked: Promise<void>
      tracked = Promise.resolve(cleanup?.()).finally(() => {
        if (inFlight === tracked) {
          inFlight = null
        }
      })
      inFlight = tracked
      return tracked
    })
    const cleanupSubscription = vi.fn(() => {
      void cleanupSubscriptionAndWait().catch(() => {})
    })
    const retrySubscriptionCleanupAfter = vi.fn(
      (_id: string, _owner: () => void | Promise<void>, gate: Promise<void>) => {
        void gate.then(async () => {
          await inFlight?.catch(() => undefined)
          cleanupSubscription()
        })
      }
    )
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer: vi.fn().mockResolvedValue(unwatch),
      registerSubscriptionCleanup: vi.fn((id, nextCleanup) => {
        subscriptionId = id
        cleanup = nextCleanup
      }),
      cleanupSubscription,
      cleanupSubscriptionAndWait,
      retrySubscriptionCleanupAfter
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const responses: { result?: { type?: string } }[] = []

    const dispatch = dispatcher.dispatchStreaming(
      makeRequest('files.watch', { worktree: 'id:wt-1' }),
      (response) => responses.push(JSON.parse(response))
    )
    await vi.waitFor(() => expect(cleanup).toBeDefined())

    await expect(cleanupSubscriptionAndWait()).rejects.toBe(cleanupError)
    await dispatch

    if (failureTiming === 'late') {
      expect(unwatch).toHaveBeenCalledTimes(1)
      resolvePhysicalExit()
    } else if (failureTiming === 'transient') {
      await expect(cleanupSubscriptionAndWait()).resolves.toBeUndefined()
    }
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledTimes(2))
    expect(cleanupSubscriptionAndWait).toHaveBeenCalledTimes(2)
    if (physicalExit) {
      await vi.waitFor(() => expect(cleanupSubscription).toHaveBeenCalledTimes(1))
      expect(retrySubscriptionCleanupAfter).toHaveBeenCalledWith(
        subscriptionId,
        cleanup,
        physicalExit
      )
    } else {
      expect(cleanupSubscription).not.toHaveBeenCalled()
      expect(retrySubscriptionCleanupAfter).not.toHaveBeenCalled()
    }
    expect(responses.filter((response) => response.result?.type === 'end')).toHaveLength(1)
  }
)
