import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { normalizeBotSidebarView } from '../../../../src/shared/bots/bot-sidebar-view'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../../host-screen/catalog/host-list-queries'
import { hostQueryKey } from '../../query/host-query-key'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HomeComputerBots } from './home-bots-query'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock('../../device-store/device-store', () => ({
  processDeviceStore: () => ({
    read: async (_hostId: string, _table: string, keys: readonly string[]) => ({
      status: 'ok',
      values: keys.map(() => null)
    }),
    write: async () => ({ written: true })
  })
}))

import { keptHomeComputers } from './kept-home-computers'
import { useHomeBots } from './use-home-bots'

// Connected on epoch 1:100; its reads never land, so only the reads seeded below exist.
const client: RpcClient = {
  sendRequest: () => new Promise(() => {}),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => 100,
  getGeneration: () => 1,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

const readAt = (at: number): HomeComputerBots => ({
  answers: [
    {
      key: 'mac\nlocal',
      pairedHostId: 'mac',
      executionHost: 'local',
      answer: {
        kind: 'bots',
        bots: [],
        hideBotCreated: false,
        view: normalizeBotSidebarView(undefined),
        enabled: true,
        takesCreate: true,
        takesTemplates: true,
        waits: {},
        needsYou: {}
      }
    }
  ],
  groups: [],
  epoch: '1:100',
  readAt: at
})

it('keeps the shown Home’s read while a hidden Home under it holds an older one', async () => {
  const queryClient = createOrcaQueryClient()
  const key = hostQueryKey('mac', 'bots.home', HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
  queryClient.setQueryData(key, readAt(1))
  const homeHosts = [{ hostId: 'mac', client }]
  const hosts = [{ id: 'mac', name: 'Mac' }]
  const noHosts = new Set<string>()
  function Home({ subscribed }: { subscribed: boolean }) {
    useHomeBots({
      homeHosts,
      hosts,
      hostStates: { mac: 'connected' },
      unreachableHosts: noHosts,
      worktreeInfo: {},
      now: 1000,
      subscribed
    })
    return createElement('home')
  }
  const homes = (...subscribed: boolean[]) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      ...subscribed.map((shown, at) => createElement(Home, { key: at, subscribed: shown }))
    )
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(homes(true))
  })
  await vi.waitFor(() => expect(keptHomeComputers().get('mac')?.folded?.readAt).toBe(1))
  // A screen over Home hides it; replacing that screen with Home stacks a second one on top.
  await act(async () => renderer?.update(homes(false)))
  await act(async () => renderer?.update(homes(false, true)))
  await act(async () => {
    queryClient.setQueryData(key, readAt(2))
  })
  await vi.waitFor(() => expect(keptHomeComputers().get('mac')?.folded?.readAt).toBe(2))
  // A loop between the two would have thrown and torn both down.
  expect(renderer?.toJSON()).toHaveLength(2)
  await act(async () => renderer?.unmount())
})
