import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { PairedServerGeneratedInputNotices } from './GeneratedInputNotices'
import { relayHostsFeed } from '../worktree/relay-hosts-feed'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcEnvelopeFields } from '../transport/rpc-envelope-fields'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'

// Host discovery polls only while the app is active; nothing else of React Native is reached.
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('./OlderGeneratedInputNotices', () => ({
  MoreGeneratedInputNoticesRow: () => null,
  OlderGeneratedInputNotices: () => null
}))
vi.mock('./HostRouteNoticeBanner', () => ({ HostRouteNoticeBanner: () => null }))

const NOTICES = 'terminal.generatedInputNotices.subscribe'

// L10/P04: the paired desktop's relay hosts each own one notice feed, through the real host list
// store, scoped client and status gate. Only that host's own lifecycle opens or closes its feed.
it.each([10, 100])('keeps one notice feed per ready host among %i hosts', async (count) => {
  const hostIds = Array.from({ length: count }, (_, index) => `runtime:host-${index}` as const)
  let unavailable = new Set<string>()
  const statusReads: string[] = []
  // Each feed the component opened, by host; disposals are counted apart from renders.
  const feeds: { host: string; disposed: number }[] = []
  const hostOf = (options?: { envelope?: RpcEnvelopeFields }) =>
    String(options?.envelope?.executionHost)
  const client = stubRpcClient({
    sendRequest: async (method, _params, options) => {
      if (method === MOBILE_RELAY_HOSTS_LIST_METHOD) {
        const hosts = hostIds.map((hostId) => ({
          hostId,
          label: hostId,
          health: 'available',
          relay: unavailable.has(hostId) ? 'unavailable' : 'ready'
        }))
        return { id: 'hosts', ok: true as const, result: { hosts } }
      }
      if (method === 'status.get') {
        statusReads.push(hostOf(options))
        return {
          id: 'status',
          ok: true as const,
          result: { capabilities: [GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY] }
        }
      }
      throw new Error(`unscripted request: ${method}`)
    },
    subscribe: (method, _params, _listener, options) => {
      if (method !== NOTICES) {
        return () => {}
      }
      const feed = { host: hostOf(options), disposed: 0 }
      feeds.push(feed)
      return () => {
        feed.disposed += 1
      }
    }
  })
  const active = () => feeds.filter(({ disposed }) => disposed === 0).map(({ host }) => host)
  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })
  }
  const refreshHosts = async () => {
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
  }
  // A route change re-renders the host surface's parent; the host owners stay mounted.
  const tree = (route: string) =>
    createElement('route', { route }, createElement(PairedServerGeneratedInputNotices, { client }))

  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(tree('workspace'))
  })
  const mounted = renderer!
  await settle()
  await vi.waitFor(() => expect(active()).toHaveLength(count))
  expect(active().toSorted()).toEqual(hostIds.toSorted())
  expect(feeds).toHaveLength(count)
  expect(statusReads.toSorted()).toEqual(hostIds.toSorted())

  // An unchanged host list, a re-render and a route change open and close nothing.
  await refreshHosts()
  act(() => mounted.update(tree('workspace')))
  act(() => mounted.update(tree('terminal')))
  await settle()
  expect(feeds).toHaveLength(count)
  expect(feeds.every(({ disposed }) => disposed === 0)).toBe(true)
  expect(statusReads).toHaveLength(count)

  // One host drops off the relay and comes back: only its own feed closes, once, and reopens.
  const host = hostIds[3]
  unavailable = new Set([host])
  await refreshHosts()
  expect(feeds.filter(({ disposed }) => disposed > 0)).toEqual([{ host, disposed: 1 }])
  expect(active()).toHaveLength(count - 1)
  unavailable = new Set()
  await refreshHosts()
  await vi.waitFor(() => expect(active()).toHaveLength(count))
  expect(feeds).toHaveLength(count + 1)
  expect(feeds.at(-1)).toEqual({ host, disposed: 0 })
  expect(statusReads.filter((read) => read !== host)).toHaveLength(count - 1)

  // Teardown releases every handle exactly once.
  act(() => mounted.unmount())
  expect(feeds.map(({ disposed }) => disposed)).toEqual(Array(count + 1).fill(1))
})
