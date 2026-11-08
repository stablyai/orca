import { createElement } from 'react'
import { focusManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { useHostEventRouter, useHostEventStreamReady } from './host-event-router'
import { defineHostQuery, useHostQuery } from './host-query'
import { hostQueryKey } from './host-query-key'
import { createOrcaQueryClient } from './orca-query-client'
import { settingsSignal } from './settings-change-signal'

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
  focusManager.setFocused(undefined)
  vi.useRealTimers()
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

// Holds its answer while the event stream is live, as a settings family on a host with settingsChanged does.
const groupOrderQuery = defineHostQuery({
  family: 'test.settings',
  fetch: rowsQuery.fetch,
  staleTime: 0,
  signal: settingsSignal(['sourceControlGroupOrder'])
})
const groupOrderKey = hostQueryKey('host-1', groupOrderQuery.family, { exec: 'local' }, NO_INPUT)

async function mountList(
  host: ReturnType<typeof desktop>,
  options: { query?: typeof rowsQuery; queryClient?: QueryClient } = {}
): Promise<() => string | undefined> {
  let rows: string | undefined
  function List(): null {
    useHostEventRouter('host-1', host.client)
    const live = useHostEventStreamReady('host-1', host.client)
    rows = useHostQuery(
      options.query ?? rowsQuery,
      { hostId: 'host-1', client: host.client },
      { exec: 'local' },
      NO_INPUT,
      { staleTime: options.query === groupOrderQuery && live ? Infinity : undefined }
    ).data
    return null
  }
  const queryClient = options.queryClient ?? createOrcaQueryClient()
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(List))
    )
  })
  await settleQueryNotifications()
  return () => rows
}

it('re-reads a settings family only for a settingsChanged naming a setting it reads', async () => {
  const host = desktop()
  await mountList(host, { query: groupOrderQuery })
  await act(async () => host.replies[0]('changes-first'))
  host.emit({ type: 'ready', subscriptionId: 'events-1' })

  host.emit({ type: 'settingsChanged', keys: ['terminalFontSize'] })
  await settleQueryNotifications()
  expect(host.replies).toHaveLength(1)

  host.emit({ type: 'settingsChanged', keys: ['terminalFontSize', 'sourceControlGroupOrder'] })
  await settleQueryNotifications()
  expect(host.replies).toHaveLength(2)
})

it('reads a settings family again on its next mount, since no stream heard the host meanwhile', async () => {
  const host = desktop()
  const queryClient = createOrcaQueryClient()
  await mountList(host, { query: groupOrderQuery, queryClient })
  await act(async () => host.replies[0]('changes-first'))
  host.emit({ type: 'ready', subscriptionId: 'events-1' })
  await act(async () => renderer?.unmount())

  await mountList(host, { query: groupOrderQuery, queryClient })
  expect(host.replies).toHaveLength(2)
})

it('keeps a settings answer stale when the change arrives during a read the page is not watching', async () => {
  const host = desktop()
  const queryClient = createOrcaQueryClient()
  await mountList(host, { query: groupOrderQuery, queryClient })
  await act(async () => host.replies[0]('changes-first'))
  host.emit({ type: 'ready', subscriptionId: 'events-1' })
  focusManager.setFocused(false)
  void queryClient.refetchQueries({ queryKey: groupOrderKey })
  await settleQueryNotifications()

  host.emit({ type: 'settingsChanged', keys: ['sourceControlGroupOrder'] })
  // This answer was read before the change.
  await act(async () => host.replies[1]('changes-first'))
  await settleQueryNotifications()
  expect(queryClient.getQueryState(groupOrderKey)?.isInvalidated).toBe(true)
})

it('reads a settings answer cached before the router started, once its stream is live', async () => {
  const host = desktop()
  const queryClient = createOrcaQueryClient()
  await mountList(host, { query: groupOrderQuery, queryClient })
  await act(async () => host.replies[0]('changes-first'))
  host.emit({ type: 'ready', subscriptionId: 'events-1' })
  await act(async () => renderer?.unmount())

  // Another screen starts the router later; its stream goes live before Changes opens.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60_000)
  function Holder(): null {
    useHostEventRouter('host-1', host.client)
    return null
  }
  let holder: ReactTestRenderer | null = null
  await act(async () => {
    holder = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Holder))
    )
  })
  host.emit({ type: 'ready', subscriptionId: 'events-2' })
  await mountList(host, { query: groupOrderQuery, queryClient })
  expect(host.replies).toHaveLength(2)
  act(() => holder?.unmount())
})
