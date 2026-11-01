import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mobileNativeChatFollowUpPreference } from './mobile-native-chat-follow-up-preference'
import { useMobileNativeChatQueueFollowUps } from './use-mobile-native-chat-queue-follow-ups'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'

function connection() {
  let state: ConnectionState = 'connected'
  let generation = 0
  const callbacks: ((event: unknown) => void)[] = []
  const states = new Set<(state: ConnectionState) => void>()
  const stops = vi.fn()
  const replies: ((reply: RpcResponse) => void)[] = []
  const failures: ((reason: Error) => void)[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>(
    () =>
      new Promise((resolve, reject) => {
        replies.push(resolve)
        failures.push(reject)
      })
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
    failures,
    callbacks,
    states,
    emit: (event: unknown) => callbacks.at(-1)?.(event),
    change: (next: ConnectionState, migrate = false) => {
      state = next
      if (migrate) {
        generation++
      }
      for (const callback of states) {
        callback(state)
      }
    }
  }
}
const reply = (queueFollowUps: boolean): RpcResponse => ({
  id: 'r',
  ok: true,
  result: { settings: { nativeChatQueueFollowUps: queueFollowUps } },
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
      snapshot: { nativeChatQueueFollowUps: true }
    })
  )
  expect(values.get('a1')).toBe(true)
  expect(values.get('a2')).toBe(true)
  expect(values.get('b')).toBe(true)
  expect(renders.get('b')).toBe(before.get('b'))
  const after = new Map(renders)
  await act(async () => a.emit({ type: 'ready', subscriptionId: 'old-no-projection' }))
  await act(async () => a.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true }))
  expect(renders).toEqual(after)
  await act(async () => a.replies[1]!(reply(false)))
  expect(values.get('a1')).toBe(true)
  await act(async () => a.replies[0]!(reply(false)))
  expect(values.get('a1')).toBe(true)
  const beforeOff = new Map(renders)
  await act(async () => a.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false }))
  expect(values.get('a1')).toBe(false)
  expect(values.get('a2')).toBe(false)
  expect(renders.get('a1')).toBe(beforeOff.get('a1')! + 1)
  expect(renders.get('a2')).toBe(beforeOff.get('a2')! + 1)
  expect(renders.get('b')).toBe(before.get('b'))
  const oldEvent = a.callbacks[0]!
  await act(async () => a.change('disconnected'))
  await act(async () => a.change('connected'))
  const beforeOn = new Map(renders)
  await act(async () =>
    a.emit({
      type: 'ready',
      subscriptionId: 'a2',
      snapshot: { nativeChatQueueFollowUps: true }
    })
  )
  expect(values.get('a1')).toBe(true)
  expect(values.get('a2')).toBe(true)
  expect(renders.get('a1')).toBe(beforeOn.get('a1')! + 1)
  expect(renders.get('a2')).toBe(beforeOn.get('a2')! + 1)
  expect(renders.get('b')).toBe(beforeOn.get('b'))
  await act(async () =>
    oldEvent({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  )
  expect(values.get('a1')).toBe(true)
  const previousTransportEvent = a.callbacks.at(-1)!
  await act(async () => a.change('connected', true))
  expect(values.get('a1')).toBe(true)
  await act(async () =>
    previousTransportEvent({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  )
  expect(values.get('a1')).toBe(true)
  // Old host ready uses the existing read fallback; latest read wins.
  await act(async () => a.emit({ type: 'ready', subscriptionId: 'old' }))
  await act(async () => a.replies.at(-1)!(reply(true)))
  expect(values.get('a1')).toBe(true)
  await act(async () => a.replies[2]!(reply(false)))
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
    snapshot: { nativeChatQueueFollowUps: true }
  })
  host.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  expect([
    fetchWorktrees.mock.calls.length,
    fetchRepoMetadata.mock.calls.length,
    syncViewSettings.mock.calls.length
  ]).toEqual(counts)
  stop()
})

it('keeps known OFF across real direct/relay migrations and failed reads, while scoped hosts start Queue', async () => {
  const direct = connection(),
    relay = connection(),
    directAgain = connection()
  const logical = createStableLogicalRpcClient(direct.client, 'lan')
  const values = new Map<string, boolean>()
  function Chat({ id, client }: { id: string; client: RpcClient | null }) {
    values.set(id, useMobileNativeChatQueueFollowUps(client, true, id))
    return null
  }
  let mounted!: ReactTestRenderer
  await act(async () => {
    mounted = create(
      <>
        <Chat id="same" client={logical} />
        <Chat id="unknown" client={null} />
      </>
    )
    renderers.add(mounted)
  })
  expect(values.get('same')).toBe(true)
  expect(values.get('unknown')).toBe(true)
  await act(async () =>
    direct.emit({
      type: 'ready',
      subscriptionId: 'd',
      snapshot: { nativeChatQueueFollowUps: false }
    })
  )
  await act(async () => direct.replies[0]!(reply(true)))
  expect(values.get('same')).toBe(false)
  await act(async () => logical.migrateTo(relay.client, 'relay'))
  expect(values.get('same')).toBe(false)
  await act(async () => relay.failures[0]!(new Error('read failed')))
  expect(values.get('same')).toBe(false)
  await act(async () =>
    direct.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true })
  )
  expect(values.get('same')).toBe(false)
  // Ready ON also fences an older OFF read.
  await act(async () => relay.emit({ type: 'ready', subscriptionId: 'legacy' }))
  await act(async () =>
    relay.emit({ type: 'ready', subscriptionId: 'r', snapshot: { nativeChatQueueFollowUps: true } })
  )
  await act(async () => relay.replies.at(-1)!(reply(false)))
  expect(values.get('same')).toBe(true)
  await act(async () =>
    relay.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  )
  await act(async () => logical.migrateTo(directAgain.client, 'lan'))
  expect(values.get('same')).toBe(false)
  await act(async () => directAgain.failures[0]!(new Error('read failed')))
  expect(values.get('same')).toBe(false)
  const sameHostEvent = directAgain.callbacks.at(-1)!
  const other = scopeRpcClientToExecutionHost(logical, 'runtime:other')
  await act(async () =>
    mounted.update(
      <>
        <Chat id="same" client={logical} />
        <Chat id="other" client={other} />
      </>
    )
  )
  expect(values.get('other')).toBe(true)
  expect(values.get('same')).toBe(false)
  await act(async () =>
    directAgain.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  )
  await act(async () =>
    sameHostEvent({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true })
  )
  expect(values.get('same')).toBe(true)
  expect(values.get('other')).toBe(false)
  await act(async () =>
    sameHostEvent({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
  )
  await act(async () => mounted.unmount())
  // Late callbacks after last unsubscribe cannot replace the retained same-host value.
  directAgain.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true })
  expect(mobileNativeChatFollowUpPreference(logical).getSnapshot()).toBe(false)
  expect(directAgain.states.size).toBe(1) // Only the logical transport's own state listener remains.
  logical.close()
  expect(directAgain.states.size).toBe(0)
})
