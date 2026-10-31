import { createElement, useSyncExternalStore } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { getProjectSectionsResource } from './project-sections-resource'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'

function owner(initialReady = false) {
  let generation = 1
  let sequence = 0
  const states = new Set<(state: ConnectionState) => void>()
  const events = new Set<(event: unknown) => void>()
  const foreground = new Set<(state: string) => void>()
  const sent: RpcRequestFrame[] = []
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++sequence),
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: (frame) => {
      sent.push(frame)
      return true
    }
  })
  const client = stubRpcClient({
    sendRequest: tracker.sendRequest.bind(tracker),
    getGeneration: () => generation,
    onStateChange: (listener) => {
      states.add(listener)
      return () => {
        states.delete(listener)
      }
    },
    subscribe: (_method, _params, listener) => {
      events.add(listener)
      if (initialReady) {
        listener({ type: 'ready' })
      }
      return () => {
        events.delete(listener)
      }
    }
  })
  const appState = {
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      foreground.add(listener)
      return {
        remove: () => {
          foreground.delete(listener)
        }
      }
    }
  }
  const resource = getProjectSectionsResource(client)
  return {
    resource,
    appState,
    sent,
    tracker,
    states,
    events,
    foreground,
    wake: (type: string) => {
      for (const listener of events) {
        listener({ type })
      }
    },
    activate: () => {
      for (const listener of foreground) {
        listener('active')
      }
    },
    connect: () => {
      generation++
      for (const listener of states) {
        listener('connected')
      }
    },
    answer: (result: unknown) => tracker.resolve({ id: sent.at(-1)!.id, ok: true, result }),
    reply: (
      reply:
        | Omit<Extract<RpcResponse, { ok: true }>, 'id'>
        | Omit<Extract<RpcResponse, { ok: false }>, 'id'>
    ) => tracker.resolve({ ...reply, id: sent.at(-1)!.id })
  }
}
const flush = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}
const catalog = { repos: [], projects: [], setups: [], projectOrderBy: 'manual' }
afterEach(() => {
  vi.useRealTimers()
})

it.each([
  { ok: false, error: { code: 'runtime_unavailable', message: 'runtime_unavailable' } },
  { ok: true, result: {} },
  { ok: true, result: { catalog: 'malformed' } }
] as const)(
  'parks failed owner input until a same-client writer wake and retains valid answers (%j)',
  async (failure) => {
    vi.useFakeTimers()
    const o = owner()
    const changed = vi.fn()
    const stop = o.resource.subscribe(changed, o.appState)
    await flush()
    o.reply(failure)
    await flush()
    expect(o.resource.getSnapshot()).toEqual({ kind: 'pending' })
    expect(o.tracker.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    o.wake('reposChanged')
    await flush()
    o.answer({ catalog })
    await flush()
    expect(o.resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
    expect(changed).toHaveBeenCalledTimes(1)
    o.activate()
    await flush()
    o.reply(failure)
    await flush()
    expect(o.resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
    expect(changed).toHaveBeenCalledTimes(1)
    o.connect()
    await flush()
    o.answer({ catalog: structuredClone(catalog) })
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
    expect(o.events.size + o.states.size + o.foreground.size).toBe(0)
  }
)

it.each([100, 1000])(
  'bounds %i reentries and dirty wakes through real finite request settlement',
  async (count) => {
    vi.useFakeTimers()
    const o = owner()
    let stop = o.resource.subscribe(vi.fn(), o.appState)
    const other = o.resource.subscribe(vi.fn(), o.appState)
    await flush()
    expect(o.sent).toHaveLength(1)
    for (let i = 0; i < count; i++) {
      stop()
      stop = o.resource.subscribe(vi.fn(), o.appState)
      o.wake('ready')
      o.wake('reposChanged')
    }
    expect(o.tracker.size()).toBe(1)
    expect(o.sent).toHaveLength(1)
    o.connect()
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(o.sent).toHaveLength(2)
    expect(o.tracker.size()).toBe(1)
    o.answer({ catalog: null })
    await flush()
    expect(o.resource.getSnapshot()).toEqual({ kind: 'answered', value: null })
    expect(o.tracker.size()).toBe(0)
    stop()
    other()
    for (let i = 0; i < count; i++) {
      stop = o.resource.subscribe(vi.fn(), o.appState)
      stop()
    }
    await flush()
    expect(o.sent).toHaveLength(2)
    expect(o.events.size + o.states.size + o.foreground.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('fences release/reentry and drains a writer invalidation through the fresh request', async () => {
  vi.useFakeTimers()
  const o = owner()
  let stop = o.resource.subscribe(vi.fn(), o.appState)
  await flush()
  stop()
  stop = o.resource.subscribe(vi.fn(), o.appState)
  o.wake('reposChanged')
  o.answer({ catalog: null })
  await flush()
  expect(o.resource.getSnapshot()).toEqual({ kind: 'pending' })
  expect(o.sent).toHaveLength(2)
  o.answer({ catalog })
  await flush()
  expect(o.resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
  stop()
  await o.resource.refresh()
  expect(o.sent).toHaveLength(2)
})

it('shares the production subscription across consumers and skips renders for equal or unrelated owner input', async () => {
  vi.useFakeTimers()
  const o = owner()
  let renders = 0
  const subscribe = (listener: () => void) => o.resource.subscribe(listener, o.appState)
  const observed: {
    current?: ReturnType<typeof o.resource.getSnapshot>
    other?: ReturnType<typeof o.resource.getSnapshot>
  } = {}
  function Probe({ primary }: { primary: boolean }): null {
    const snapshot = useSyncExternalStore(subscribe, o.resource.getSnapshot)
    if (primary) {
      renders++
      observed.current = snapshot
    } else {
      observed.other = snapshot
    }
    return null
  }
  let hook: ReactTestRenderer | undefined
  let otherHook: ReactTestRenderer | undefined
  let stop: (() => void) | undefined
  try {
    await act(async () => {
      hook = create(createElement(Probe, { primary: true }))
      otherHook = create(createElement(Probe, { primary: false }))
      await flush()
    })
    expect(o.sent).toHaveLength(1)
    await act(async () => {
      o.answer({ catalog })
      await flush()
    })
    expect(observed.current).toEqual({ kind: 'answered', value: catalog })
    const settled = renders
    await act(async () => {
      o.wake('unrelatedSettings')
      await flush()
    })
    expect(renders).toBe(settled)
    const other = owner()
    stop = other.resource.subscribe(vi.fn(), other.appState)
    await act(async () => {
      await flush()
      other.answer({ catalog: null })
      await flush()
    })
    expect(renders).toBe(settled)
    await act(async () => {
      o.wake('ready')
      await flush()
      o.answer({ catalog: structuredClone(catalog) })
      await flush()
    })
    expect(renders).toBe(settled)
    await act(async () => {
      o.wake('reposChanged')
      await flush()
      o.answer({ catalog: { ...catalog, projectOrderBy: 'recent' } })
      await flush()
    })
    expect(renders).toBe(settled + 1)
    expect(observed.current).toEqual(observed.other)
  } finally {
    await act(async () => {
      hook?.unmount()
      otherHook?.unmount()
    })
    stop?.()
  }
})

it('settles the initial subscription-ready race and a rejected read through a legitimate wake', async () => {
  vi.useFakeTimers()
  const o = owner(true)
  const changed = vi.fn()
  const stop = o.resource.subscribe(changed, o.appState)
  await flush()
  expect(o.sent).toHaveLength(1)
  o.tracker.rejectAll('Connection interrupted')
  await flush()
  expect(o.sent).toHaveLength(2)
  o.answer({ catalog })
  await flush()
  expect(changed).toHaveBeenCalledTimes(1)
  expect(o.resource.getSnapshot()).toEqual({ kind: 'answered', value: catalog })
  expect(o.tracker.size()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  stop()
})
