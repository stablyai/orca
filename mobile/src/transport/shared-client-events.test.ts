import { describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from './rpc-client-test-stub'
import { subscribeSharedClientEvents, type SharedClientEvent } from './shared-client-events'

function wire() {
  const opened: { method: string; emit: (payload: unknown) => void; stop: () => void }[] = []
  const stateListeners = new Set<(state: 'connected' | 'disconnected') => void>()
  let connectedAt = 1000
  const client = stubRpcClient({
    getLastConnectedAt: () => connectedAt,
    onStateChange: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    subscribe: (method, _params, listener) => {
      const stop = vi.fn()
      opened.push({ method, emit: listener, stop })
      return stop
    }
  })
  return {
    client,
    opened,
    reconnect: () => {
      connectedAt += 1
      for (const listener of stateListeners) {
        listener('disconnected')
        listener('connected')
      }
    }
  }
}

function recorder() {
  const events: SharedClientEvent[] = []
  return { events, listener: (event: SharedClientEvent) => events.push(event) }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('subscribeSharedClientEvents', () => {
  it('shares one wire subscription, keeps it across a same-tick rejoin and closes it with the last listener or the wire end', async () => {
    const { client, opened } = wire()
    const a = recorder()
    const b = recorder()
    const stopA = subscribeSharedClientEvents(client, a.listener)
    const stopB = subscribeSharedClientEvents(client, b.listener)
    expect(opened.map((stream) => stream.method)).toEqual(['runtime.clientEvents.subscribe'])

    opened[0]!.emit({ type: 'reposChanged' })
    expect(a.events).toEqual([{ type: 'reposChanged' }])
    expect(b.events).toEqual([{ type: 'reposChanged' }])

    stopA()
    stopB()
    const stopRejoined = subscribeSharedClientEvents(client, recorder().listener)
    await flush()
    expect(opened).toHaveLength(1)
    expect(opened[0]!.stop).not.toHaveBeenCalled()
    stopRejoined()
    await flush()
    expect(opened[0]!.stop).toHaveBeenCalledTimes(1)

    const c = recorder()
    subscribeSharedClientEvents(client, c.listener)
    opened[1]!.emit({ type: 'end' })
    expect(c.events).toEqual([{ type: 'end' }])
    subscribeSharedClientEvents(client, recorder().listener)
    expect(opened).toHaveLength(3)
  })

  it('gives a late listener a joined ready only after the wire ready on the current connection', async () => {
    const { client, opened, reconnect } = wire()
    const first = recorder()
    const early = recorder()
    subscribeSharedClientEvents(client, first.listener)
    subscribeSharedClientEvents(client, early.listener)
    await flush()
    expect(early.events).toEqual([])

    opened[0]!.emit({ type: 'ready', subscriptionId: 'sub-1' })
    const late = recorder()
    subscribeSharedClientEvents(client, late.listener)
    await flush()
    expect(late.events).toEqual([{ type: 'ready', joined: true }])

    reconnect()
    const afterReconnect = recorder()
    subscribeSharedClientEvents(client, afterReconnect.listener)
    await flush()
    expect(afterReconnect.events).toEqual([])

    opened[0]!.emit({ type: 'ready', subscriptionId: 'sub-2' })
    const replayed = { type: 'ready', subscriptionId: 'sub-2', replayed: true }
    expect(first.events).toEqual([{ type: 'ready', subscriptionId: 'sub-1' }, replayed])
    expect(early.events).toEqual([{ type: 'ready', subscriptionId: 'sub-1' }, replayed])
    expect(late.events).toEqual([{ type: 'ready', joined: true }, replayed])
    expect(afterReconnect.events).toEqual([{ type: 'ready', subscriptionId: 'sub-2' }])
    expect(opened).toHaveLength(1)
  })

  it('opens the wire again for its listeners after a live stream ends, and after a refused one only on the next connection', async () => {
    const { client, opened, reconnect } = wire()
    const home = recorder()
    const preference = recorder()
    subscribeSharedClientEvents(client, home.listener)
    subscribeSharedClientEvents(client, preference.listener)
    opened[0]!.emit({ type: 'ready', subscriptionId: 'sub-1' })

    opened[0]!.emit({ type: 'end' })
    await flush()
    expect(opened).toHaveLength(2)
    opened[0]!.emit({ type: 'reposChanged' })
    opened[1]!.emit({ type: 'ready', subscriptionId: 'sub-2' })
    opened[1]!.emit({ type: 'reposChanged' })
    const afterEnd = [
      { type: 'ready', subscriptionId: 'sub-1' },
      { type: 'end' },
      { type: 'ready', subscriptionId: 'sub-2', replayed: true },
      { type: 'reposChanged' }
    ]
    expect(home.events).toEqual(afterEnd)
    expect(preference.events).toEqual(afterEnd)

    opened[1]!.emit({ type: 'error', message: 'interrupted' })
    await flush()
    expect(opened).toHaveLength(3)
    opened[2]!.emit({ type: 'error', message: 'refused' })
    await flush()
    expect(opened).toHaveLength(3)

    reconnect()
    expect(opened).toHaveLength(4)
    opened[3]!.emit({ type: 'reposChanged' })
    expect(home.events.at(-1)).toEqual({ type: 'reposChanged' })
    expect(preference.events.at(-1)).toEqual({ type: 'reposChanged' })
  })

  it('tries a refused wire once per connected edge', () => {
    const listeners = new Set<(state: 'connected') => void>()
    let attempts = 0
    const client = stubRpcClient({
      onStateChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      subscribe: () => {
        attempts += 1
        throw new Error('over 32 subscriptions')
      }
    })
    subscribeSharedClientEvents(client, recorder().listener)
    expect(attempts).toBe(1)

    // Like the page's connection cache, which notifies over its live listener set.
    for (const listener of listeners) {
      listener('connected')
      if (attempts > 10) {
        break
      }
    }
    expect(attempts).toBe(2)
  })
})
