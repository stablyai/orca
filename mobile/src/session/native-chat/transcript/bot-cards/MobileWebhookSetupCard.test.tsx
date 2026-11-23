import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../../../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { MobileWebhookSetupCard } from './MobileWebhookSetupCard'
import { MobileBotCardHostContext, type MobileBotCardHost } from './mobile-bot-card-host'

const { written, foreground } = vi.hoisted(() => {
  const copied: string[] = []
  const listeners: ((state: string) => void)[] = []
  return { written: copied, foreground: listeners }
})
vi.mock('../../../../platform/clipboard/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async (value: string) => void written.push(value) })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  useColorScheme: () => 'dark',
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, listener: (state: string) => void) => {
      foreground.push(listener)
      return { remove: () => {} }
    }
  },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => {} }) }
}))
// Every icon as a host element named after it.
vi.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name), has: () => true })
)

const HOOK = 'wh_PhoneCardTest001'
const URL = `https://connector.orca.dev/hooks/${HOOK}/secret-key`

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  written.length = 0
})

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const card = (state: 'pending' | 'live', hookId = HOOK) => ({
  id: 'rpc-card',
  ok: true as const,
  result: { hookId, botId: 'bot-1', state, url: URL, automationName: 'x' }
})
const revealed = { id: 'rpc-key', ok: true as const, result: { url: URL, key: 'secret-key' } }

// Each test its own hook: a copied URL's receipt lasts the session.
function mount(hookId: string) {
  const client = createFakeRpcClient()
  const host: MobileBotCardHost = {
    client,
    hostKey: 'h',
    pairedHostId: 'p',
    hostLabel: 'Mac',
    openBotChat: () => {},
    editOffer: () => {}
  }
  act(() => {
    tree = create(
      createElement(
        MobileBotCardHostContext.Provider,
        { value: host },
        createElement(MobileWebhookSetupCard, {
          hookId,
          name: 'Failed payment follow-up',
          fontScale: 1
        })
      )
    )
  })
  return client
}

const pill = (label: string) =>
  tree!.root.findAll(
    (node) => node.props.label === label && typeof node.props.onPress === 'function'
  )[0]
const text = () => JSON.stringify(tree!.toJSON())

it('copies the key-bearing URL from the setup card and keeps a receipt', async () => {
  const client = mount(HOOK)
  client.requests[0]?.resolve(card('live'))
  await flush()
  expect(pill('Copy URL')?.props.disabled).toBe(false)

  act(() => pill('Copy URL')!.props.onPress())
  await flush()
  expect(client.requests[1]?.method).toBe('webhooks.reveal')
  client.requests[1]?.resolve(revealed)
  await flush()
  expect(written).toEqual([URL])
  expect(text()).toContain('✓ URL copied')
})

it('says the key was copied, and a card gone before the host answers copies nothing', async () => {
  const client = mount('wh_PhoneCardTest002')
  client.requests[0]?.resolve(card('live', 'wh_PhoneCardTest002'))
  await flush()
  act(() => pill('Key and signing secret')!.props.onPress())
  const keyCopy = tree!.root.findAll(
    (node) => node.props.children === 'Copy' && typeof node.props.onPress === 'function'
  )[0]
  act(() => keyCopy!.props.onPress())
  await flush()
  client.requests[1]?.resolve(revealed)
  await flush()
  expect(written).toEqual(['secret-key'])
  expect(text()).toContain('Key copied')

  written.length = 0
  act(() => pill('Copy URL')!.props.onPress())
  await flush()
  act(() => tree?.unmount())
  tree = null
  client.requests[2]?.resolve(revealed)
  await flush()
  expect(written).toEqual([])
})

it('reads a setting-up hook again until it is live, so Copy URL turns on by itself', async () => {
  const client = mount('wh_PhoneCardTest003')
  client.requests[0]?.resolve(card('pending', 'wh_PhoneCardTest003'))
  await flush()
  expect(pill('Getting the URL…')?.props.disabled).toBe(true)

  act(() => foreground.forEach((listener) => listener('active')))
  client.requests[1]?.resolve(card('live', 'wh_PhoneCardTest003'))
  await flush()
  expect(client.requests[1]?.method).toBe('webhooks.card')
  expect(pill('Copy URL')?.props.disabled).toBe(false)
})
