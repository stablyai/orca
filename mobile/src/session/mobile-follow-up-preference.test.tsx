import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  mobileNativeChatHostPreference,
  QUEUE_FOLLOW_UPS_PREFERENCE
} from './mobile-native-chat-host-preference'
import { useMobileNativeChatQueueFollowUps } from './use-mobile-native-chat-queue-follow-ups'
import { useMobileNativeChatCiResultLines } from './use-mobile-native-chat-ci-result-lines'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'

function connection() {
  let state: ConnectionState = 'connected'
  let generation = 0
  const callbacks: ((event: unknown) => void)[] = []
  const routedCallbacks: { host: string | undefined; callback: (event: unknown) => void }[] = []
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
    subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, callback, options) => {
      callbacks.push(callback)
      const host = options?.envelope?.executionHost
      routedCallbacks.push({ host: typeof host === 'string' ? host : undefined, callback })
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
    emitAt: (host: string | undefined, event: unknown) =>
      routedCallbacks.findLast((entry) => entry.host === host)?.callback(event),
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
const settingsReply = (settings: Record<string, unknown>): RpcResponse => ({
  id: 'r',
  ok: true,
  result: { settings },
  _meta: { runtimeId: 'r' }
})
const reply = (queueFollowUps: boolean): RpcResponse =>
  settingsReply({ nativeChatQueueFollowUps: queueFollowUps })

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
    values.set(id, useMobileNativeChatQueueFollowUps(client, true, id, client, true))
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
  await act(async () => a.change('connected', true))
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
  expect(b.stops).toHaveBeenCalledTimes(1)
})

it('keeps known OFF across real direct/relay migrations and failed reads, while scoped hosts start Queue', async () => {
  const direct = connection(),
    relay = connection(),
    directAgain = connection()
  const logical = createStableLogicalRpcClient(direct.client, 'lan')
  const values = new Map<string, boolean>()
  function Chat({ id, client }: { id: string; client: RpcClient | null }) {
    values.set(id, useMobileNativeChatQueueFollowUps(client, true, id, client, true))
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
  expect(mobileNativeChatHostPreference(logical, QUEUE_FOLLOW_UPS_PREFERENCE).getSnapshot()).toBe(
    false
  )
  expect(directAgain.states.size).toBe(1) // Only the logical transport's own state listener remains.
  logical.close()
  expect(directAgain.states.size).toBe(0)
})

it('re-renders only the consumers of the preference and desktop that changed', async () => {
  const a = connection(),
    b = connection()
  const renders = new Map<string, number>()
  const values = new Map<string, boolean>()
  const count = (id: string, value: boolean) => {
    values.set(id, value)
    renders.set(id, (renders.get(id) ?? 0) + 1)
  }
  function CiLines({ id, client }: { id: string; client: RpcClient }) {
    count(id, useMobileNativeChatCiResultLines(client, true))
    return null
  }
  function FollowUps({ id, client }: { id: string; client: RpcClient }) {
    count(id, useMobileNativeChatQueueFollowUps(client, true, id, client, true))
    return null
  }
  await act(async () => {
    renderers.add(
      create(
        <>
          <CiLines id="ci-a" client={a.client} />
          <FollowUps id="follow-ups-a" client={a.client} />
          <CiLines id="ci-b" client={b.client} />
          {Array.from({ length: 9 }, (_, index) => (
            <CiLines key={index} id={`ci-b${index}`} client={b.client} />
          ))}
        </>
      )
    )
  })
  await act(async () => {})
  // Ten chats on B share one read and one stream.
  expect(b.client.sendRequest).toHaveBeenCalledTimes(1)
  expect(b.client.subscribe).toHaveBeenCalledTimes(1)
  // B executes the chat and reports CI lines on; A, the paired desktop, hasn't reported.
  await act(async () => b.emit({ type: 'nativeChatCiResultLinesChanged', ciResultLines: true }))
  expect([values.get('ci-a'), values.get('follow-ups-a'), values.get('ci-b')]).toEqual([
    false,
    true,
    true
  ])
  const settled = new Map(renders)
  await act(async () => a.emit({ type: 'nativeChatCiResultLinesChanged', ciResultLines: true }))
  expect(values.get('ci-a')).toBe(true)
  expect(renders).toEqual(new Map([...settled, ['ci-a', settled.get('ci-a')! + 1]]))
  await act(async () => a.emit({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false }))
  expect(values.get('follow-ups-a')).toBe(false)
  expect(renders).toEqual(
    new Map([
      ...settled,
      ['ci-a', settled.get('ci-a')! + 1],
      ['follow-ups-a', settled.get('follow-ups-a')! + 1]
    ])
  )
  const beforeOther = new Map(renders)
  await act(async () => b.emit({ type: 'nativeChatCiResultLinesChanged', ciResultLines: false }))
  expect(values.get('ci-b')).toBe(false)
  expect(renders.get('ci-a')).toBe(beforeOther.get('ci-a'))
  expect(renders.get('follow-ups-a')).toBe(beforeOther.get('follow-ups-a'))
  // A snapshot-less ready re-reads once for the connection, not once per chat.
  await act(async () => b.emit({ type: 'ready', subscriptionId: 'legacy' }))
  expect(b.client.sendRequest).toHaveBeenCalledTimes(2)
})

it('shows CI lines from the last value the paired desktop reported, hidden until it reports one', async () => {
  const desktop = connection()
  const values: boolean[] = []
  function Chat() {
    values.push(useMobileNativeChatCiResultLines(desktop.client, true))
    return null
  }
  let chat!: ReactTestRenderer
  function NoDesktop() {
    values.push(useMobileNativeChatCiResultLines(null, true))
    return null
  }
  await act(async () => {
    renderers.add(create(<NoDesktop />))
  })
  expect(values.at(-1)).toBe(false)
  await act(async () => {
    chat = create(<Chat />)
    renderers.add(chat)
  })
  // An older desktop omits the field from both its ready snapshot and its settings.
  await act(async () => desktop.emit({ type: 'ready', subscriptionId: 'old', snapshot: {} }))
  await act(async () => desktop.replies.at(-1)!(settingsReply({ nativeChatQueueFollowUps: true })))
  expect(values.at(-1)).toBe(false)
  await act(async () =>
    desktop.emit({ type: 'nativeChatCiResultLinesChanged', ciResultLines: true })
  )
  expect(values.at(-1)).toBe(true)
  await act(async () => desktop.change('disconnected'))
  // Draw again while disconnected: a phone resume must not blink the line out.
  await act(async () => chat.update(<Chat />))
  expect(values.at(-1)).toBe(true)
  await act(async () => desktop.change('connected'))
  await act(async () =>
    desktop.emit({
      type: 'ready',
      subscriptionId: 'new',
      snapshot: { nativeChatCiResultLines: false }
    })
  )
  expect(values.at(-1)).toBe(false)
})

it('keeps a pending follow-ups read when a CI change lands on a joined stream', async () => {
  const desktop = connection()
  const values = new Map<string, boolean>()
  function FollowUps() {
    values.set(
      'follow-ups',
      useMobileNativeChatQueueFollowUps(desktop.client, true, 'f', desktop.client, true)
    )
    return null
  }
  function CiLines() {
    values.set('ci', useMobileNativeChatCiResultLines(desktop.client, true))
    return null
  }
  const first = create(<FollowUps />)
  renderers.add(first)
  await act(async () => {})
  // A legacy ready re-reads follow-ups; that read is still out when a later chat joins the stream.
  await act(async () => desktop.emit({ type: 'ready', subscriptionId: 'legacy' }))
  const followUpsRead = desktop.replies.at(-1)!
  await act(async () =>
    first.update(
      <>
        <FollowUps />
        <CiLines />
      </>
    )
  )
  const ciRead = desktop.replies.at(-1)!
  await act(async () =>
    desktop.emit({ type: 'nativeChatCiResultLinesChanged', ciResultLines: true })
  )
  await act(async () =>
    followUpsRead(
      settingsReply({ nativeChatQueueFollowUps: false, nativeChatCiResultLines: false })
    )
  )
  await act(async () =>
    ciRead(settingsReply({ nativeChatQueueFollowUps: true, nativeChatCiResultLines: false }))
  )
  expect(values).toEqual(
    new Map([
      ['follow-ups', false],
      ['ci', true]
    ])
  )
})
