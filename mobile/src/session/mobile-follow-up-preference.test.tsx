import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileNativeChatQueueFollowUps } from './use-mobile-native-chat-queue-follow-ups'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'

function connection() {
  let state: ConnectionState = 'connected'
  let generation = 0
  const callbacks: ((event: unknown) => void)[] = []
  const states = new Set<(state: ConnectionState) => void>()
  const stops = vi.fn()
  const replies: ((reply: RpcResponse) => void)[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>(
    () => new Promise((resolve) => replies.push(resolve))
  )
  const client: RpcClient = {
    sendRequest,
    subscribe: vi.fn((_method, _params, callback) => {
      callbacks.push(callback)
      return stops
    }),
    onStateChange: (callback) => {
      states.add(callback)
      return () => {
        states.delete(callback)
      }
    },
    getState: () => state,
    getGeneration: () => generation,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    notifyForeground: () => {},
    close: () => {},
    updateTerminalSubscriptionViewport: () => {}
  }
  return {
    client,
    stops,
    replies,
    callbacks,
    states,
    emit: (event: unknown) => callbacks.at(-1)?.(event),
    change: (next: ConnectionState, replaceHost = false) => {
      state = next
      if (replaceHost) {
        generation++
      }
      for (const callback of states) {
        callback(state)
      }
    }
  }
}
const reply = (behavior: string): RpcResponse => ({
  id: 'r',
  ok: true,
  result: { settings: { nativeChatFollowUpBehavior: behavior } },
  _meta: { runtimeId: 'r' }
})

const renderers = new Set<ReactTestRenderer>()
afterEach(() => {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
})

it('shares one live scalar per connection, fences late reads/events, and isolates real hook renders', async () => {
  const a = connection(),
    b = connection()
  const renders = new Map<string, number>()
  const values = new Map<string, boolean>()
  function Chat({ id, client }: { id: string; client: RpcClient }) {
    values.set(id, useMobileNativeChatQueueFollowUps(client, true, id))
    renders.set(id, (renders.get(id) ?? 0) + 1)
    return null
  }
  let mounted: ReactTestRenderer | undefined
  await act(async () => {
    mounted = create(
      <>
        <Chat id="a1" client={a.client} />
        <Chat id="a2" client={a.client} />
        <Chat id="b" client={b.client} />
      </>
    )
    renderers.add(mounted)
  })
  await act(async () => {})
  expect(a.client.subscribe).toHaveBeenCalledTimes(1)
  expect(b.client.subscribe).toHaveBeenCalledTimes(1)
  const before = new Map(renders)
  for (const count of [10, 100]) {
    for (let index = 0; index < count; index++) {
      await act(async () => a.emit({ type: 'workspaceViewChanged' }))
    }
    expect(renders).toEqual(before)
    expect(a.client.sendRequest).toHaveBeenCalledTimes(1)
    expect(a.client.subscribe).toHaveBeenCalledTimes(1)
  }
  await act(async () =>
    a.emit({
      type: 'ready',
      subscriptionId: 'a',
      snapshot: { nativeChatFollowUpBehavior: 'queue' }
    })
  )
  expect(values.get('a1')).toBe(true)
  expect(values.get('a2')).toBe(true)
  expect(values.get('b')).toBe(false)
  expect(renders.get('b')).toBe(before.get('b'))
  const after = new Map(renders)
  await act(async () => a.emit({ type: 'nativeChatFollowUpBehaviorChanged', behavior: 'queue' }))
  expect(renders).toEqual(after)
  await act(async () => a.replies[0]!(reply('steer')))
  expect(values.get('a1')).toBe(true)
  await act(async () => a.emit({ type: 'nativeChatFollowUpBehaviorChanged', behavior: 'steer' }))
  expect(values.get('a1')).toBe(false)
  const oldEvent = a.callbacks[0]!
  await act(async () => a.change('disconnected'))
  await act(async () => a.change('connected'))
  await act(async () =>
    a.emit({
      type: 'ready',
      subscriptionId: 'a2',
      snapshot: { nativeChatFollowUpBehavior: 'queue' }
    })
  )
  expect(values.get('a1')).toBe(true)
  await act(async () => oldEvent({ type: 'nativeChatFollowUpBehaviorChanged', behavior: 'steer' }))
  expect(values.get('a1')).toBe(true)
  const previousHostEvent = a.callbacks.at(-1)!
  await act(async () => a.change('connected', true))
  expect(values.get('a1')).toBe(false)
  await act(async () =>
    previousHostEvent({ type: 'nativeChatFollowUpBehaviorChanged', behavior: 'queue' })
  )
  expect(values.get('a1')).toBe(false)
  // Old host ready uses the existing read fallback; latest read wins.
  await act(async () => a.emit({ type: 'ready', subscriptionId: 'old' }))
  await act(async () => a.replies.at(-1)!(reply('queue')))
  expect(values.get('a1')).toBe(true)
  await act(async () => a.replies[1]!(reply('steer')))
  expect(values.get('a1')).toBe(true)
  await act(async () => mounted?.unmount())
  expect(a.states.size).toBe(0)
  expect(b.states.size).toBe(0)
  expect(a.stops).toHaveBeenCalledTimes(3)
  expect(b.stops).toHaveBeenCalledTimes(1)
})

it('existing phone workspace event reader ignores additive preference snapshot and events', async () => {
  const { startHostWorktreeRefresh } = await import('../worktree/host-worktree-refresh')
  const host = connection()
  const fetchWorktrees = vi.fn(async () => {}),
    fetchRepoMetadata = vi.fn(async () => {}),
    syncViewSettings = vi.fn(async () => {})
  const stop = startHostWorktreeRefresh({
    client: host.client,
    fetchWorktrees,
    fetchRepoMetadata,
    syncViewSettings,
    appState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
  })
  const counts = [
    fetchWorktrees.mock.calls.length,
    fetchRepoMetadata.mock.calls.length,
    syncViewSettings.mock.calls.length
  ]
  host.emit({
    type: 'ready',
    subscriptionId: 'old',
    snapshot: { nativeChatFollowUpBehavior: 'queue' }
  })
  host.emit({ type: 'nativeChatFollowUpBehaviorChanged', behavior: 'steer' })
  expect([
    fetchWorktrees.mock.calls.length,
    fetchRepoMetadata.mock.calls.length,
    syncViewSettings.mock.calls.length
  ]).toEqual(counts)
  stop()
})
