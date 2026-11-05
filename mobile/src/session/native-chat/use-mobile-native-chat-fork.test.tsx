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

/** A connection whose agent-list reads fail as scripted (true = fails), as when the socket drops. */
function connection(failures: number | readonly boolean[]) {
  const listeners = new Set<(state: 'connected' | 'reconnecting') => void>()
  const script =
    typeof failures === 'number' ? Array.from({ length: failures }, () => true) : [...failures]
  let generation = 1
  const sendRequest = vi.fn(async () => {
    if (script.shift() === true) {
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
    getGeneration: () => generation,
    onStateChange: (listener: (state: 'connected' | 'reconnecting') => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as RpcClient
  const reconnect = () => listeners.forEach((listener) => listener('connected'))
  const migrate = () => {
    generation++
    reconnect()
  }
  return { client, sendRequest, reconnect, migrate }
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

it('gives a new connection its own retries after an earlier one used them up', async () => {
  vi.useFakeTimers()
  const { client, sendRequest, migrate } = connection([true, true, true, false, true, false])
  act(() => {
    renderer = create(createElement(Probe, { client }))
  })
  await settle()
  for (const wait of [2_000, 8_000, 30_000]) {
    await act(async () => {
      vi.advanceTimersByTime(wait)
    })
    await settle()
  }
  // Learned on the fourth read, after three failures.
  expect(sendRequest).toHaveBeenCalledTimes(4)

  // The transport moves while learned: no listener is installed to see its connected event.
  act(() => migrate())
  act(() => renderer!.update(createElement(Probe, { client })))
  await settle()
  expect(sendRequest).toHaveBeenCalledTimes(5)
  await act(async () => {
    vi.advanceTimersByTime(2_000)
  })
  await settle()
  expect(sendRequest).toHaveBeenCalledTimes(6)
  await act(async () => {
    vi.advanceTimersByTime(120_000)
  })
  expect(sendRequest).toHaveBeenCalledTimes(6)
})
