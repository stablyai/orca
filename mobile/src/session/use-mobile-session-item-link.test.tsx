import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileSessionItemLink } from './use-mobile-session-item-link'

type Params = Record<string, string>
const page: {
  update: (route: { params?: Params }) => void
  search: Params
  shell: Params | null
  navigation: { setParams: () => void }
} = vi.hoisted(() => ({
  update: () => {},
  search: {},
  shell: null,
  navigation: { setParams: () => {} }
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => page.search,
  useNavigation: () => page.navigation
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../transport/connection/client-context.web', () => {
  const client = {
    getShellSession: () => (page.shell ? { route: { params: page.shell } } : null),
    clearRouteParam: () => {},
    onRouteUpdate: (listener: (route: { params?: Params }) => void) => {
      page.update = listener
      return () => {}
    }
  }
  return { usePageBridgeClient: () => client }
})

const item = (itemId: string) => JSON.stringify({ sessionId: 'lead', itemId })
const request = (paneIntent: string, paneKey: string, botItem?: string): Params => ({
  paneIntent,
  paneKey,
  ...(botItem === undefined ? {} : { botItem })
})

/** The item the page would still scroll to after the deliveries arrive in order. */
async function pendingAfter(
  deliveries: ({ bridge: Params } | { url: Params })[],
  mounted: { shell?: Params; url?: Params } = {}
) {
  let link: ReturnType<typeof useMobileSessionItemLink> | undefined
  function Probe() {
    link = useMobileSessionItemLink(() => {})
    return null
  }
  page.search = mounted.url ?? {}
  page.shell = mounted.shell ?? null
  let tree: ReturnType<typeof create> | undefined
  await act(async () => {
    tree = create(createElement(Probe))
  })
  for (const delivery of deliveries) {
    await act(async () => {
      if ('bridge' in delivery) {
        page.update({ params: delivery.bridge })
      } else {
        page.search = delivery.url
        tree?.update(createElement(Probe))
      }
    })
  }
  await act(async () => tree?.unmount())
  return link?.navigation?.target.itemId ?? null
}

it.each(['bridge', 'url'] as const)(
  'ends an earlier item when a newer request names none, on the same pane before it was used (%s)',
  async (path) => {
    const deliver = (params: Params) => (path === 'bridge' ? { bridge: params } : { url: params })
    expect(
      await pendingAfter([
        deliver(request('i-1', 'pane-1', item('q-1'))),
        deliver(request('i-2', 'pane-1'))
      ])
    ).toBe(null)
  }
)

it.each(['bridge', 'url'] as const)(
  'ends an earlier item when a newer request for another pane names none, after acknowledgements (%s)',
  async (path) => {
    const deliver = (params: Params) => (path === 'bridge' ? { bridge: params } : { url: params })
    expect(
      await pendingAfter([
        deliver(request('i-1', 'pane-1', item('q-1'))),
        deliver(request('i-1', 'pane-1', '')),
        deliver(request('i-1', '', '')),
        deliver(request('i-2', 'pane-2'))
      ])
    ).toBe(null)
  }
)

it.each(['bridge', 'url'] as const)(
  'keeps an item through acknowledgements and echoes of its own request (%s, control)',
  async (path) => {
    const deliver = (params: Params) => (path === 'bridge' ? { bridge: params } : { url: params })
    expect(
      await pendingAfter([
        deliver(request('i-1', 'pane-1', item('q-1'))),
        deliver(request('i-1', 'pane-1', '')),
        deliver(request('i-1', '', '')),
        deliver(request('i-1', '', ''))
      ])
    ).toBe('q-1')
  }
)

it('gives a newer request its own item, even on the same pane (control)', async () => {
  expect(
    await pendingAfter([
      { bridge: request('i-1', 'pane-1', item('q-1')) },
      { bridge: request('i-2', 'pane-1', item('q-2')) }
    ])
  ).toBe('q-2')
})

it('ends an earlier item for a newer request with a malformed one (control)', async () => {
  expect(
    await pendingAfter([
      { bridge: request('i-1', 'pane-1', item('q-1')) },
      { bridge: request('i-2', 'pane-1', 'nope') }
    ])
  ).toBe(null)
})

it('ends an earlier item when a pane request without an intent moves to another pane', async () => {
  expect(
    await pendingAfter([
      { bridge: { paneKey: 'pane-1', botItem: item('q-1') } },
      { bridge: { paneKey: 'pane-2', botItem: '' } }
    ])
  ).toBe(null)
  expect(
    await pendingAfter([
      { bridge: { paneKey: 'pane-1', botItem: item('q-1') } },
      { bridge: { paneKey: '', botItem: '' } },
      { bridge: { paneKey: 'pane-1' } }
    ])
  ).toBe(null)
})

it('keeps an item through acknowledgements of a request without an intent (control)', async () => {
  expect(
    await pendingAfter([
      { bridge: { paneKey: 'pane-1', botItem: item('q-1') } },
      { bridge: { paneKey: 'pane-1', botItem: '' } }
    ])
  ).toBe('q-1')
})

it.each([
  ['its newer item', item('q-2'), 'q-2'],
  ['no item when the newer request names none', undefined, null]
] as const)(
  'starts from the shell’s newer request over the boot URL’s older one: %s',
  async (_, newer, pending) => {
    expect(
      await pendingAfter([], {
        url: request('i-1', 'pane-1', item('q-1')),
        shell: request('i-2', 'pane-1', newer)
      })
    ).toBe(pending)
  }
)
