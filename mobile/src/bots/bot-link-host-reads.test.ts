import { expect, it, vi } from 'vitest'
import {
  readBotComputerAnswers,
  readBotLinkComputerAnswers,
  withoutRelayedTwins,
  type BotLinkComputerAnswer
} from './bot-link-host-reads'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { resolveBotLink } from '../../../src/shared/bots/bot-link-resolution'

function silentHost() {
  let state: ReturnType<RpcClient['getState']> = 'connected'
  let generation = 1
  const listeners = new Set<Parameters<RpcClient['onStateChange']>[0]>()
  let complete!: (value: RpcResponse) => void
  const waiting = new Promise<RpcResponse>((resolve) => {
    complete = resolve
  })
  const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> = {
    getState: () => state,
    getGeneration: () => generation,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendRequest: async () => waiting
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery uses only request and connection observation from this port.
  const client = partial as RpcClient
  return {
    client,
    release: () => complete({ id: 'late', ok: true, result: {} }),
    disconnect: () => {
      state = 'disconnected'
      generation++
      for (const listener of listeners) {
        listener(state)
      }
    }
  }
}

it('settles prerequisite discovery on disconnect instead of waiting for reconnect', async () => {
  const host = silentHost()
  const reading = readBotLinkComputerAnswers(host.client, 'paired')
  host.disconnect()
  expect((await reading)[0]?.answer.kind).toBe('unreachable')
  host.release()
})

it('settles prerequisite discovery at the drawer deadline and on caller cancellation', async () => {
  vi.useFakeTimers()
  const first = silentHost(),
    second = silentHost()
  const abort = new AbortController()
  try {
    const timeout = readBotLinkComputerAnswers(first.client, 'first')
    const cancelled = readBotLinkComputerAnswers(second.client, 'second', { signal: abort.signal })
    abort.abort()
    expect((await cancelled)[0]?.answer.kind).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await timeout)[0]?.answer.kind).toBe('unreachable')
  } finally {
    first.release()
    second.release()
    vi.useRealTimers()
  }
})

it.each(['refused', 'thrown', 'accepted-empty'] as const)(
  'retains failed relay discovery without claiming absence: %s',
  async (mode) => {
    const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> =
      {
        getState: () => 'connected',
        getGeneration: () => 1,
        onStateChange: () => () => {},
        sendRequest: async (method) => {
          if (method === 'status.get') {
            return {
              id: 'r',
              ok: true,
              result: {
                protocolVersion: 10,
                minCompatibleMobileVersion: 1,
                appVersion: '1.4.232',
                capabilities: ['bots.mobile.v1', 'mobile.desktop-relay.v1', 'bots.session-links.v1']
              }
            }
          }
          if (method === 'bots.list') {
            return {
              id: 'r',
              ok: true,
              result: { bots: [], botsEnabled: true, hideBotCreatedWorkspaces: false }
            }
          }
          if (mode === 'thrown') {
            throw new Error('Relay inventory failed')
          }
          return mode === 'refused'
            ? {
                id: 'r',
                ok: false,
                error: { code: 'unavailable', message: 'Relay inventory refused' }
              }
            : { id: 'r', ok: true, result: { hosts: [] } }
        }
      }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery uses only request and connection observation from this port.
    const answers = await readBotLinkComputerAnswers(partial as RpcClient, 'paired')
    const result = resolveBotLink(
      'relay-bot',
      answers.map(({ key, answer }) => ({ hostId: key, answer }))
    )
    if (mode === 'accepted-empty') {
      expect(result).toEqual({ kind: 'missing' })
    } else {
      expect(answers.some(({ answer }) => answer.kind === 'unreadable')).toBe(true)
      expect(result).toMatchObject({ kind: 'unreachable' })
    }
  }
)

it('keeps the relay that lists a server two computers relay, when the other can’t reach it', () => {
  const relay = (pairedHostId: string, answer: BotLinkComputerAnswer['answer']) => ({
    key: `${pairedHostId}\nruntime:build-box`,
    pairedHostId,
    executionHost: 'runtime:build-box' as const,
    installationId: 'install-build-box',
    answer
  })
  const listedThroughB = relay('b', { kind: 'bots', bots: [] })
  expect(withoutRelayedTwins([relay('a', { kind: 'unreachable' }), listedThroughB])).toEqual([
    listedThroughB
  ])
})

it('marks the relayed servers unknown when the computer’s status can’t be read', async () => {
  const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> = {
    getState: () => 'connected',
    getGeneration: () => 1,
    onStateChange: () => () => {},
    sendRequest: async () => {
      throw new Error('status failed')
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only request and connection observation from this port.
  const answers = await readBotComputerAnswers(partial as RpcClient, 'paired')
  expect(answers.map(({ key, answer }) => [key, answer.kind])).toEqual([
    ['paired\nlocal', 'unreadable'],
    ['paired\nrelay-inventory', 'unreadable']
  ])
})
