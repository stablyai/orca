import { expect, it, vi } from 'vitest'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { defineHostMutation, runHostMutation, type HostMutationPhase } from './host-mutation'
import { isHostNotConnectedError } from './host-query-errors'
import { createOrcaQueryClient } from './orca-query-client'

const NAME_KEY = ['orca', 'host-1', 'test.name', { exec: 'local' }, {}] as const

function host(initial: ConnectionState) {
  let state = initial
  const listeners = new Set<(state: ConnectionState) => void>()
  const sent: { method: string; failWhenDisconnected: boolean }[] = []
  let answer: (outcome: RpcResponse | Error) => void = () => {}
  const client = stubRpcClient({
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The transport's contract: failWhenDisconnected refuses at once while down; otherwise the request waits.
    sendRequest: (method, _params, options) => {
      sent.push({ method, failWhenDisconnected: options?.failWhenDisconnected === true })
      if (options?.failWhenDisconnected && state !== 'connected') {
        return Promise.reject(new Error(`Not connected: ${method}`))
      }
      return new Promise<RpcResponse>((resolve, reject) => {
        answer = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome))
      })
    }
  })
  return {
    client,
    sent,
    answer: (outcome: RpcResponse | Error) => answer(outcome),
    setState(next: ConnectionState) {
      state = next
      listeners.forEach((listener) => listener(next))
    }
  }
}

async function sendName(client: RpcClient, vars: { name: string }): Promise<string> {
  const reply = await client.sendRequest('test.rename', vars)
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  return vars.name
}

const rename = defineHostMutation({
  offline: 'draft',
  send: sendName,
  confirm: sendName,
  optimistic: {
    keys: () => [NAME_KEY],
    apply: (queryClient, _hostId, vars: { name: string }) =>
      queryClient.setQueryData(NAME_KEY, vars.name)
  }
})

// `current` is the host's client at each moment; a reconnect can replace it.
function run(current: RpcClient | (() => RpcClient), phases: HostMutationPhase[]) {
  const clientNow = typeof current === 'function' ? current : () => current
  const queryClient = createOrcaQueryClient()
  queryClient.setQueryData(NAME_KEY, 'old')
  const done = runHostMutation(
    rename,
    {
      hostId: 'host-1',
      queryClient,
      client: clientNow,
      connected: () =>
        new Promise<void>((resolve) => {
          const client = clientNow()
          if (client.getState() === 'connected') {
            resolve()
            return
          }
          const stop = client.onStateChange((state) => {
            if (state === 'connected') {
              stop()
              resolve()
            }
          })
        }),
      onPhase: (phase) => phases.push(phase)
    },
    { name: 'new' }
  )
  return { queryClient, done }
}

const ok: RpcResponse = { id: '1', ok: true, result: {}, _meta: { runtimeId: 'r' } }

it('keeps a write whose reply was lost and settles it once the host is back', async () => {
  const desktop = host('connected')
  const phases: HostMutationPhase[] = []
  const { queryClient, done } = run(desktop.client, phases)
  await new Promise((resolve) => setTimeout(resolve, 0))

  desktop.setState('reconnecting')
  desktop.answer(markRpcDeliveryUnknown(new Error('Connection closed')))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(phases).toEqual(['pending', 'unconfirmed'])
  expect(queryClient.getQueryData(NAME_KEY)).toBe('new')
  expect(desktop.sent).toHaveLength(1)

  desktop.setState('connected')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(desktop.sent).toHaveLength(2)
  desktop.answer(ok)
  await expect(done).resolves.toBe('new')
  expect(queryClient.getQueryData(NAME_KEY)).toBe('new')
  expect(phases).toEqual(['pending', 'unconfirmed', 'idle'])
})

it('rolls a refused write back', async () => {
  const desktop = host('connected')
  const { queryClient, done } = run(desktop.client, [])
  await new Promise((resolve) => setTimeout(resolve, 0))
  desktop.answer({ id: '1', ok: false, error: { code: 'conflict', message: 'Name taken' } })
  await expect(done).rejects.toThrow('Name taken')
  expect(queryClient.getQueryData(NAME_KEY)).toBe('old')
})

it('refuses a draft write while the host is down instead of waiting for it', async () => {
  const desktop = host('disconnected')
  const { queryClient, done } = run(desktop.client, [])
  const failure = await done.catch((error: unknown) => error)
  expect(isHostNotConnectedError(failure)).toBe(true)
  expect(queryClient.getQueryData(NAME_KEY)).toBe('old')
})

it('settles a lost reply through the client a reconnect put in place', async () => {
  const before = host('connected')
  const after = host('connected')
  let current = before.client
  const { done } = run(() => current, [])
  await new Promise((resolve) => setTimeout(resolve, 0))

  before.setState('reconnecting')
  before.answer(markRpcDeliveryUnknown(new Error('Connection closed')))
  current = after.client
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(after.sent).toHaveLength(1)
  after.answer(ok)
  await expect(done).resolves.toBe('new')
  expect(before.sent).toHaveLength(1)
})

it('checks a lost reply again after a path switch instead of failing it', async () => {
  vi.useFakeTimers()
  try {
    const desktop = host('connected')
    const { done } = run(desktop.client, [])
    await vi.advanceTimersByTimeAsync(0)
    desktop.answer(markRpcDeliveryUnknown(new Error('Connection closed')))
    await vi.advanceTimersByTimeAsync(0)
    desktop.answer(new LogicalClientCutoverError())
    await vi.advanceTimersByTimeAsync(250)
    expect(desktop.sent).toHaveLength(3)
    desktop.answer(ok)
    await expect(done).resolves.toBe('new')
  } finally {
    vi.useRealTimers()
  }
})
