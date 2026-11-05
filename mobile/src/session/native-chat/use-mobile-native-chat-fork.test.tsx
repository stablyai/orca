import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/agent-session-create-capabilities'
import type { RpcClient } from '../../transport/rpc-client'
import { useMobileNativeChatFork } from './use-mobile-native-chat-fork'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.useRealTimers()
})

/** A connection whose first agent-list reads fail, as when the socket drops mid-request. */
function connection(failures: number) {
  const listeners = new Set<(state: 'connected' | 'reconnecting') => void>()
  let left = failures
  const sendRequest = vi.fn(async () => {
    if (left-- > 0) {
      throw new Error('Connection interrupted')
    }
    return {
      ok: true,
      result: { agents: [{ agent: 'claude', capabilities: { fork: 'checkpoint' } }] }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only sendRequest, onStateChange and getGeneration from its client.
  const client = {
    sendRequest,
    getGeneration: () => 1,
    onStateChange: (listener: (state: 'connected' | 'reconnecting') => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as RpcClient
  const reconnect = () => listeners.forEach((listener) => listener('connected'))
  return { client, sendRequest, reconnect }
}

function Probe({ client }: { client: RpcClient }): null {
  useMobileNativeChatFork({
    client,
    hostCapabilities: [AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY],
    agent: 'claude',
    sessionId: 'session-1',
    messages: [],
    turnJournal: null,
    agentWorking: false,
    sessionForkSupport: 'supported',
    createFork: async () => {}
  })
  return null
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

it('asks again after a failed read, then again once the connection recovers', async () => {
  vi.useFakeTimers()
  const { client, sendRequest, reconnect } = connection(5)
  act(() => {
    renderer = create(createElement(Probe, { client }))
  })
  await settle()
  expect(sendRequest).toHaveBeenCalledTimes(1)
  for (const wait of [2_000, 8_000, 30_000]) {
    await act(async () => {
      vi.advanceTimersByTime(wait)
    })
    await settle()
  }
  // Retries are bounded on one connection.
  expect(sendRequest).toHaveBeenCalledTimes(4)
  await act(async () => {
    vi.advanceTimersByTime(120_000)
  })
  expect(sendRequest).toHaveBeenCalledTimes(4)

  act(() => reconnect())
  await settle()
  expect(sendRequest).toHaveBeenCalledTimes(5)
  act(() => reconnect())
  await settle()
  // Learned: a later reconnect on the same connection reads nothing more.
  expect(sendRequest).toHaveBeenCalledTimes(6)
  act(() => reconnect())
  await settle()
  expect(sendRequest).toHaveBeenCalledTimes(6)
})
