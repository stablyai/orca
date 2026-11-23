import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../../../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { MobileWebhookSetupCard } from './MobileWebhookSetupCard'
import { MobileBotCardHostContext } from './mobile-bot-card-host'

const written: string[] = []
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
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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

it('copies the key-bearing URL from the setup card and keeps a receipt', async () => {
  const client = createFakeRpcClient()
  const host = { client, hostKey: 'h', pairedHostId: 'p' } as never
  act(() => {
    tree = create(
      createElement(
        MobileBotCardHostContext.Provider,
        { value: host },
        createElement(MobileWebhookSetupCard, {
          hookId: HOOK,
          name: 'Failed payment follow-up',
          fontScale: 1
        })
      )
    )
  })
  // The card reads its hook; answer it live.
  client.requests[0]?.resolve({
    id: 'rpc-1',
    ok: true,
    result: { hookId: HOOK, botId: 'bot-1', state: 'live', url: URL, automationName: 'x' }
  })
  await flush()
  const copy = tree!.root.findAll(
    (node) => node.props.label === 'Copy URL' && typeof node.props.onPress === 'function'
  )[0]
  expect(copy?.props.disabled).toBe(false)

  act(() => copy!.props.onPress())
  await flush()
  expect(client.requests[1]?.method).toBe('webhooks.reveal')
  client.requests[1]?.resolve({ id: 'rpc-2', ok: true, result: { url: URL, key: 'secret-key' } })
  await flush()
  expect(written).toEqual([URL])
  expect(JSON.stringify(tree!.toJSON())).toContain('✓ URL copied')
})
