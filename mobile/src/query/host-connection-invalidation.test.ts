import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { defineHostQuery, useHostQuery } from './host-query'
import { createOrcaQueryClient } from './orca-query-client'

const NO_INPUT = {}

const rowsQuery = defineHostQuery({
  family: 'test.rows',
  fetch: async (client, _target, _input: typeof NO_INPUT) => {
    const reply = await client.sendRequest('test.rows')
    return reply.ok ? String(reply.result) : 'refused'
  }
})

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function step(run: () => unknown): Promise<void> {
  await act(async () => {
    await run()
  })
  await settleQueryNotifications()
}

function hostWithRows() {
  let state: ConnectionState = 'connected'
  const listeners = new Set<(state: ConnectionState) => void>()
  const pending: ((rows: string) => void)[] = []
  const client = stubRpcClient({
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The transport's failWhenDisconnected contract: refuse at once while down.
    sendRequest: (method, _params, options) =>
      options?.failWhenDisconnected && state !== 'connected'
        ? Promise.reject(new Error(`Not connected: ${method}`))
        : new Promise<RpcResponse>((resolve) => {
            pending.push((rows) =>
              resolve({ id: '1', ok: true, result: rows, _meta: { runtimeId: 'r' } })
            )
          })
  })
  return {
    client,
    setState(next: ConnectionState) {
      state = next
      listeners.forEach((listener) => listener(next))
    },
    reply: (rows: string) => pending.shift()?.(rows),
    pendingCount: () => pending.length
  }
}

it('keeps the rows through a refused read and refills them on the connected edge', async () => {
  const host = hostWithRows()
  const queryClient = createOrcaQueryClient()
  const seen: { data?: string } = {}
  function Screen(): null {
    seen.data = useHostQuery(
      rowsQuery,
      { hostId: 'host-1', client: host.client },
      { exec: 'local' },
      NO_INPUT
    ).data
    return null
  }
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Screen))
    )
  })
  await step(() => host.reply('rows-1'))
  expect(seen.data).toBe('rows-1')

  await step(() => {
    host.setState('reconnecting')
    return queryClient.invalidateQueries()
  })
  expect(seen.data).toBe('rows-1')
  expect(host.pendingCount()).toBe(0)

  await step(() => host.setState('connected'))
  expect(host.pendingCount()).toBe(1)
  await step(() => host.reply('rows-2'))
  expect(seen.data).toBe('rows-2')
})
