import { describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from './rpc-client-test-stub'
import { subscribeSharedClientEvents, type SharedClientEvent } from './shared-client-events'

function wire() {
  const opened: { method: string; emit: (payload: unknown) => void; stop: () => void }[] = []
  let connectedAt = 1000
  const client = stubRpcClient({
    getLastConnectedAt: () => connectedAt,
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
    const replayed = { type: 'ready', subscriptionId: 'sub-2' }
    expect(first.events).toEqual([{ type: 'ready', subscriptionId: 'sub-1' }, replayed])
    expect(early.events).toEqual([{ type: 'ready', subscriptionId: 'sub-1' }, replayed])
    expect(late.events).toEqual([{ type: 'ready', joined: true }, replayed])
    expect(afterReconnect.events).toEqual([replayed])
    expect(opened).toHaveLength(1)
  })
})
