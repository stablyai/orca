import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileNativeChatQueueFollowUps } from './use-mobile-native-chat-queue-follow-ups'
import { useMobileNativeChatCiResultLines } from './use-mobile-native-chat-ci-result-lines'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'

function connection() {
  let state: ConnectionState = 'connected'
  const callbacks: ((event: unknown) => void)[] = []
  const states = new Set<(state: ConnectionState) => void>()
  const replies: ((reply: RpcResponse) => void)[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>(
    () =>
      new Promise((resolve) => {
        replies.push(resolve)
      })
  )
  const client: RpcClient = {
    sendRequest,
    subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, callback) => {
      callbacks.push(callback)
      return () => {}
    }),
    onStateChange: (callback) => {
      states.add(callback)
      return () => {
        states.delete(callback)
      }
    },
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    notifyForeground: () => {},
    close: () => {},
    updateTerminalSubscriptionViewport: () => {}
  }
  return {
    client,
    replies,
    emit: (event: unknown) => callbacks.at(-1)?.(event),
    change: (next: ConnectionState) => {
      state = next
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

const renderers = new Set<ReactTestRenderer>()
afterEach(() => {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
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
