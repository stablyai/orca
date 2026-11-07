import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { BridgeConnectionCache } from '../mobile-web-shell/bridge/bridge-client-connection-cache'
import { publishConnectionRevival } from '../transport/connection-revival-signal'
import { useAutomationCatalog } from './use-automation-catalog'
import { automationClient, deferred, savedAutomation } from './automation-test-fixtures'

const foreground = vi.hoisted(() => ({ change: (_state: string) => {} }))
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, change: (state: string) => void) => {
      foreground.change = change
      return {
        remove: () => {
          foreground.change = () => {}
        }
      }
    }
  }
}))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})
function latest<T>(read: () => T | null) {
  const value = read()
  if (!value) {
    throw new Error('Not mounted')
  }
  return value
}

function catalogReply(name = 'Review changes') {
  const automation = { ...savedAutomation(), name }
  return {
    automations: [automation],
    items: [{ automationId: automation.id, selector: { kind: 'self' } }]
  }
}
async function mountCatalog(client: RpcClient, server = false) {
  let state: ReturnType<typeof useAutomationCatalog> | null = null
  function Probe({ port }: { port: RpcClient }) {
    state = useAutomationCatalog(port, server)
    return null
  }
  await act(async () => {
    tree = create(createElement(Probe, { port: client }))
  })
  return {
    read: () => latest(() => state),
    replace: async (port: RpcClient) => {
      await act(async () => tree?.update(createElement(Probe, { port })))
    }
  }
}
function trackedCatalog() {
  const port = automationClient(() => ({}))
  const frames: RpcRequestFrame[] = []
  const tracker = new RpcClientRequestTracker({
    nextId: () => `catalog-${frames.length}`,
    getState: port.client.getState,
    waitForConnected: async () => {},
    sendFrame: (frame) => {
      frames.push(frame)
      return true
    }
  })
  port.client.sendRequest = (...args) => tracker.sendRequest(...args)
  const reply = (offset: number, name = 'Review changes') => {
    for (const frame of frames.slice(offset, offset + 2)) {
      tracker.resolve({
        id: frame.id,
        ok: true,
        result: frame.method === 'status.get' ? { capabilities: [] } : catalogReply(name)
      })
    }
  }
  return { ...port, tracker, frames, reply }
}

describe('host-owned automation reads', () => {
  it.each([10, 100])(
    'coalesces %s meaningful refreshes and awaits each explicit batch without starving publication',
    async (events) => {
      const port = trackedCatalog()
      const { read } = await mountCatalog(port.client)
      let firstDone = false
      let laterDone = false
      let first: Promise<void> = Promise.resolve()
      await act(async () => {
        port.event({ type: 'ready' })
        for (let index = 0; index < events; index++) {
          port.event({ type: 'automationsChanged' })
        }
        foreground.change('active')
        publishConnectionRevival('network-change')
        first = read()
          .refresh(true)
          .then(() => {
            firstDone = true
          })
        void read().refresh(true)
      })
      expect(port.frames).toHaveLength(2)
      expect(firstDone).toBe(false)
      await act(async () => port.reply(0, 'Initial'))
      expect(read().rows[0]?.automation.name).toBe('Initial')
      expect(port.frames).toHaveLength(4)
      expect(firstDone).toBe(false)
      await act(async () => {
        void read()
          .refresh(true)
          .then(() => {
            laterDone = true
          })
        port.event({ type: 'automationsChanged' })
        port.reply(2, 'First explicit')
        await first
      })
      expect(firstDone).toBe(true)
      expect(laterDone).toBe(false)
      expect(read().rows[0]?.automation.name).toBe('First explicit')
      expect(port.frames).toHaveLength(6)
      await act(async () => port.reply(4, 'Later explicit'))
      expect(laterDone).toBe(true)
      expect(read().rows[0]?.automation.name).toBe('Later explicit')
      expect(port.tracker.size()).toBe(0)
    }
  )

  it('retires pre-settlement reads before accepting rows without cancelling a user write', async () => {
    const port = trackedCatalog()
    const { read } = await mountCatalog(port.client)
    await act(async () => port.reply(0))
    const oldSnapshot = read().isCurrentSnapshot
    let waiterDone = false
    await act(async () => {
      void read()
        .refresh(true)
        .then(() => {
          waiterDone = true
        })
    })
    const write = deferred<void>()
    let action: Promise<void> = Promise.resolve()
    await act(async () => {
      action = read().perform(
        async (client, current) => {
          const response = await client.sendRequest('automation.delete', {})
          expect(current()).toBe(true)
          expect(response.ok).toBe(true)
          await write.promise
        },
        () => {
          expect(oldSnapshot()).toBe(false)
          read().setRows([])
        }
      )
    })
    expect(port.frames.at(-1)?.method).toBe('automation.delete')
    const frame = port.frames.at(-1)!
    await act(async () => {
      port.tracker.resolve({ id: frame.id, ok: true, result: {} })
    })
    expect(read().busy).toBe(true)
    expect(port.tracker.size()).toBe(2)
    await act(async () => {
      write.resolve()
      await action
    })
    expect(waiterDone).toBe(true)
    expect(read().rows).toEqual([])
    expect(oldSnapshot()).toBe(false)
    expect(port.tracker.size()).toBe(2)
    await act(async () => port.reply(2, 'Stale'))
    expect(read().rows).toEqual([])
    await act(async () => port.reply(5, 'After write'))
    expect(read().rows[0]?.automation.name).toBe('After write')
    expect(read().isCurrentSnapshot()).toBe(true)
  })

  it('only clears the warning captured by a successful explicit intent, including identical text', async () => {
    const port = trackedCatalog()
    const { read } = await mountCatalog(port.client)
    await act(async () => port.reply(0))
    await act(async () => {
      read().setError('Action may have applied')
      void read().refresh()
      void read().refresh(true)
      read().setError(() => 'Action may have applied')
    })
    await act(async () => port.reply(2))
    await act(async () => port.reply(4))
    expect(read().error).toBe('Action may have applied')
    let completed = false
    await act(async () => {
      void read()
        .refresh(true)
        .then(() => {
          completed = true
        })
    })
    await act(async () => port.reply(6))
    expect(completed).toBe(true)
    expect(read().error).toBeNull()
  })

  it.each(['rejection', 'timeout', 'unreadable', 'sync-start'] as const)(
    'abandons the sibling after %s and admits one queued recovery through the real tracker',
    async (failure) => {
      vi.useFakeTimers()
      const port = trackedCatalog()
      if (failure === 'sync-start') {
        const send = port.client.sendRequest
        port.client.sendRequest = (method, ...args) => {
          if (method === 'status.get') {
            throw new Error('status start failed')
          }
          return send(method, ...args)
        }
      }
      const { read } = await mountCatalog(port.client)
      if (failure === 'sync-start') {
        expect(read().error).toBeTruthy()
        expect(port.tracker.size()).toBe(0)
        expect(vi.getTimerCount()).toBe(1)
        port.client.sendRequest = (...args) => port.tracker.sendRequest(...args)
        await act(async () => {
          void read().refresh()
        })
        await act(async () => port.reply(0, 'Recovered'))
        expect(read().error).toBeNull()
        expect(read().loaded).toBe(true)
        return
      }
      await act(async () => {
        void read().refresh()
      })
      expect(port.tracker.size()).toBe(2)
      await act(async () => {
        const list = port.frames[0]!
        if (failure === 'timeout') {
          port.tracker.resolve({ id: port.frames[1]!.id, ok: true, result: { capabilities: [] } })
          await vi.advanceTimersByTimeAsync(30000)
        } else {
          port.tracker.resolve(
            failure === 'rejection'
              ? {
                  id: list.id,
                  ok: false,
                  error: { code: 'runtime_error', message: 'list unavailable' }
                }
              : { id: list.id, ok: true, result: null }
          )
          if (failure === 'unreadable') {
            port.tracker.resolve({ id: port.frames[1]!.id, ok: true, result: { capabilities: [] } })
          }
        }
      })
      expect(read().error).toBeTruthy()
      expect(port.frames).toHaveLength(4)
      expect(port.tracker.size()).toBe(2)
      expect(vi.getTimerCount()).toBe(3)
      await act(async () => port.reply(2, 'Recovered'))
      expect(read().error).toBeNull()
      expect(read().rows[0]?.automation.name).toBe('Recovered')
      expect(port.tracker.size()).toBe(0)
      expect(vi.getTimerCount()).toBe(1)
    }
  )

  it('settles queued explicit intent when a rebuilt shell silently replaces its generation', async () => {
    vi.useFakeTimers()
    const cache = new BridgeConnectionCache()
    cache.prime({
      state: 'connected',
      generation: 5,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null
    })
    const transitions = vi.fn()
    cache.onStateChange(transitions)
    const port = trackedCatalog()
    port.client.getState = () => cache.require().state
    port.client.getGeneration = () => cache.require().generation ?? 0
    port.client.onStateChange = (listener) => cache.onStateChange(listener)
    const { read } = await mountCatalog(port.client)
    let settled = false
    await act(async () => {
      port.event({ type: 'ready' })
      void read()
        .refresh(true)
        .then(() => {
          settled = true
        })
      cache.prime({ ...cache.require(), generation: 2 })
      port.reply(0, 'Retired generation')
    })
    expect(transitions).not.toHaveBeenCalled()
    expect(settled).toBe(true)
    expect(read().loaded).toBe(false)
    expect(read().isCurrentSnapshot()).toBe(false)
    expect(port.tracker.size()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(port.frames).toHaveLength(2)
    await act(async () => {
      void read().refresh(true)
    })
    await act(async () => port.reply(2, 'Rebuilt shell'))
    expect(read().rows[0]?.automation.name).toBe('Rebuilt shell')
    expect(read().isCurrentSnapshot()).toBe(true)
  })

  it('retires waiters and ignores late completion across connection, client and unmount lifetimes', async () => {
    const port = trackedCatalog()
    const { read, replace } = await mountCatalog(port.client)
    let retired = 0
    await act(async () => {
      void read()
        .refresh(true)
        .then(() => {
          retired++
        })
    })
    await act(async () => {
      port.state('disconnected')
      port.state('connected')
    })
    expect(retired).toBe(1)
    expect(port.tracker.size()).toBe(2)
    await act(async () => port.reply(0, 'Old connection'))
    expect(read().loaded).toBe(false)
    await act(async () => port.reply(2, 'Current connection'))
    expect(read().rows[0]?.automation.name).toBe('Current connection')
    await act(async () => {
      void read().refresh()
      void read()
        .refresh(true)
        .then(() => {
          retired++
        })
    })
    const replacement = trackedCatalog()
    await replace(replacement.client)
    expect(retired).toBe(2)
    expect(port.tracker.size()).toBe(0)
    await act(async () => port.reply(4, 'Old host'))
    expect(replacement.tracker.size()).toBe(2)
    await act(async () => replacement.reply(0, 'New host'))
    expect(read().rows[0]?.automation.name).toBe('New host')
    await act(async () => {
      void read().refresh()
      void read()
        .refresh(true)
        .then(() => {
          retired++
        })
    })
    await act(async () => tree?.unmount())
    tree = null
    expect(retired).toBe(3)
    expect(replacement.tracker.size()).toBe(0)
    expect(replacement.frames).toHaveLength(4)
  })

  it.each([
    [20000, 20000],
    [0, 29000]
  ])(
    'publishes a slow catalog pair (%s/%s ms) across periodic ticks without debt',
    async (listMs, statusMs) => {
      vi.useFakeTimers()
      const automation = savedAutomation()
      const replies: { method: string; value: ReturnType<typeof deferred<unknown>> }[] = []
      const port = automationClient((method) => {
        const value = deferred<unknown>()
        replies.push({ method, value })
        return value.promise
      })
      const deliver = (index: number) => {
        const reply = replies[index]!
        reply.value.resolve(
          reply.method === 'status.get' ? { capabilities: ['catalog-ready'] } : catalogReply()
        )
      }
      let state: ReturnType<typeof useAutomationCatalog> | null = null
      function Probe() {
        state = useAutomationCatalog(port.client, true)
        return null
      }
      await act(async () => {
        tree = create(createElement(Probe))
      })
      if (listMs === 0) {
        await act(async () => deliver(0))
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.max(listMs, statusMs))
      })
      await act(async () => {
        deliver(0)
        deliver(1)
      })
      const read = () => latest(() => state)
      expect(read().loaded).toBe(true)
      expect(read().rows[0]?.automation.id).toBe(automation.id)
      expect(read().capabilities).toEqual(['catalog-ready'])
      expect(read().revision).toBe(1)
      expect(port.send).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000 - Math.max(listMs, statusMs))
      })
      expect(port.send).toHaveBeenCalledTimes(4)
    }
  )
})
