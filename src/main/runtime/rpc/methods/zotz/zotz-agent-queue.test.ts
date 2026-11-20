import { describe, expect, it, vi } from 'vitest'
import { registerZotzAgentQueueSource } from '../../../../zotz/memory-governor/zotz-agent-queue-source'
import {
  ZOTZ_AGENT_QUEUE_SNAPSHOT_METHOD as snapshotMethod,
  ZOTZ_AGENT_QUEUE_SUBSCRIBE_METHOD as subscribeMethod
} from './zotz-agent-queue'

function rpcContext(signal: AbortSignal): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime.registerSubscriptionCleanup, signal and connectionId, so a partial context is enough.
  return {
    runtime: { registerSubscriptionCleanup: vi.fn() },
    signal,
    connectionId: 'socket-1'
  } as never
}

function queuedCount(frame: unknown): number {
  return typeof frame === 'object' &&
    frame !== null &&
    'queued' in frame &&
    Array.isArray(frame.queued)
    ? frame.queued.length
    : -1
}

describe('zotz.agentQueue', () => {
  it('answers an empty queue when this host runs no memory limiter', async () => {
    const snapshot = await snapshotMethod.handler({}, rpcContext(new AbortController().signal))
    expect(snapshot).toEqual({ memory: null, running: [], done: [], queued: [], canceled: [] })
  })

  it('streams the queue on connect and on every change until the client leaves', async () => {
    let queued: unknown[] = []
    const queueListeners = new Set<() => void>()
    const stopQueue = vi.fn()
    const unregister = registerZotzAgentQueueSource({
      governor: {
        getState: () => null,
        wake: vi.fn(),
        subscribe: () => () => {}
      },
      queue: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot builder copies only id, agent, priority, label, estimatedBytes, enqueuedAt, position and waitReason from each task.
        list: () => queued as never,
        listCanceled: () => [],
        subscribe: (listener) => {
          queueListeners.add(listener)
          return () => {
            stopQueue()
            queueListeners.delete(listener)
          }
        }
      }
    })
    const emitted: unknown[] = []
    const leave = new AbortController()

    const stream = subscribeMethod.handler({}, rpcContext(leave.signal), (frame) =>
      emitted.push(frame)
    )
    await Promise.resolve()
    expect(emitted.map(queuedCount)).toEqual([0])

    queued = [
      {
        id: 'task-1',
        agent: 'claude',
        priority: 'interactive',
        label: 'uni',
        estimatedBytes: 1,
        enqueuedAt: 1,
        position: 1,
        waitReason: 'pressure'
      }
    ]
    queueListeners.forEach((listener) => listener())
    expect(emitted.map(queuedCount)).toEqual([0, 1])

    leave.abort()
    await stream
    expect(stopQueue).toHaveBeenCalledTimes(1)
    expect(queueListeners.size).toBe(0)
    unregister()
  })
})
