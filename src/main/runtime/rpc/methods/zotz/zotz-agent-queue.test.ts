import { describe, expect, it, vi } from 'vitest'
import { registerZotzAgentQueueSource } from '../../../../zotz/memory-governor/zotz-agent-queue-source'
import { ZotzAgentQueueTaskParams } from '../../../../../shared/rpc-contract/zotz/zotz-agent-queue-params'
import {
  ZOTZ_AGENT_QUEUE_CANCEL_METHOD as cancelMethod,
  ZOTZ_AGENT_QUEUE_DISMISS_CANCELED_METHOD as dismissMethod,
  ZOTZ_AGENT_QUEUE_FORCE_START_METHOD as forceStartMethod,
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
        cancel: vi.fn(),
        forceStart: vi.fn(),
        dismissCanceled: vi.fn(),
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
  it('sends cancel, launch anyway and dismiss to the limiter of this host', async () => {
    const cancel = vi.fn()
    const forceStart = vi.fn()
    const dismissCanceled = vi.fn()
    const unregister = registerZotzAgentQueueSource({
      governor: { getState: () => null, wake: vi.fn(), subscribe: () => () => {} },
      queue: {
        list: () => [],
        listCanceled: () => [],
        subscribe: () => () => {},
        cancel,
        forceStart,
        dismissCanceled
      }
    })
    const context = rpcContext(new AbortController().signal)

    await expect(cancelMethod.handler({ id: 'pane-1' }, context)).resolves.toEqual({ ok: true })
    await forceStartMethod.handler({ id: 'pane-2' }, context)
    await dismissMethod.handler({ id: 'pane-3' }, context)

    expect(cancel).toHaveBeenCalledWith('pane-1')
    expect(forceStart).toHaveBeenCalledWith('pane-2')
    expect(dismissCanceled).toHaveBeenCalledWith('pane-3')
    unregister()
  })

  it('does nothing, without failing, on a host that runs no memory limiter', async () => {
    await expect(
      forceStartMethod.handler({ id: 'pane-1' }, rpcContext(new AbortController().signal))
    ).resolves.toEqual({ ok: true })
  })

  it('rejects an empty or oversized task id', () => {
    expect(ZotzAgentQueueTaskParams.safeParse({ id: '' }).success).toBe(false)
    expect(ZotzAgentQueueTaskParams.safeParse({ id: 'x'.repeat(1025) }).success).toBe(false)
    expect(ZotzAgentQueueTaskParams.safeParse({ id: 'pane-1' }).success).toBe(true)
  })
})
