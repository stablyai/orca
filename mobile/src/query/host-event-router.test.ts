import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { useHostEventRouter } from './host-event-router'
import { defineHostQuery, useHostQuery } from './host-query'
import { createOrcaQueryClient } from './orca-query-client'

const NO_INPUT = {}

const rowsQuery = defineHostQuery({
  family: 'test.rows',
  fetch: async (client, _target, _input: typeof NO_INPUT) => {
    const reply = await client.sendRequest('test.rows')
    return reply.ok ? String(reply.result) : 'refused'
  },
  signal: { events: ['worktreesChanged'] }
})

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function desktop() {
  let emit: (event: unknown) => void = () => {}
  const replies: ((rows: string) => void)[] = []
  const stateListeners = new Set<(state: 'connected' | 'disconnected') => void>()
  const client = stubRpcClient({
    getLastConnectedAt: () => 1,
    onStateChange: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    subscribe: (_method, _params, onData) => {
      emit = onData
      return () => {}
    },
    sendRequest: () =>
      new Promise<RpcResponse>((resolve) => {
        replies.push((rows) => resolve({ id: 'r', ok: true, result: rows }))
      })
  })
  return {
    client,
    emit: (event: unknown) => emit(event),
    replies,
    setState: (state: 'connected' | 'disconnected') => stateListeners.forEach((l) => l(state))
  }
}

async function mountList(host: ReturnType<typeof desktop>): Promise<() => string | undefined> {
  let rows: string | undefined
  function List(): null {
    useHostEventRouter('host-1', host.client)
    rows = useHostQuery(
      rowsQuery,
      { hostId: 'host-1', client: host.client },
      { exec: 'local' },
      NO_INPUT
    ).data
    return null
  }
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: createOrcaQueryClient() }, createElement(List))
    )
  })
  await settleQueryNotifications()
  return () => rows
}

it('reads again when the desktop reports a change during a read, ending on the rows after it', async () => {
  const host = desktop()
  const rows = await mountList(host)
  host.emit({ type: 'ready', subscriptionId: 'events-1' })
  expect(host.replies).toHaveLength(1)

  // The read already out was sent before this change, so its rows may not include it.
  host.emit({ type: 'worktreesChanged', repoId: 'repo-1', sortOrderOnly: false })
  await act(async () => host.replies[0]('before'))
  await settleQueryNotifications()
  expect(host.replies).toHaveLength(2)

  await act(async () => host.replies[1]('after'))
  await settleQueryNotifications()
  expect(rows()).toBe('after')
})
