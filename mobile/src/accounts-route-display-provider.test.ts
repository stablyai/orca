import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../app/h/[hostId]/accounts'
import type { AccountsSnapshot, ProviderRateLimits } from './components/account-usage-state'

const dependencies = vi.hoisted(() => ({
  loadHosts: vi.fn(),
  snapshot: null as AccountsSnapshot | null,
  subscribe: vi.fn()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: 'host-1' }),
  useRouter: () => ({ back: vi.fn() })
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  Gauge: 'Gauge',
  RefreshCw: 'RefreshCw',
  User: 'User'
}))

vi.mock('./transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))
vi.mock('./transport/client-context', () => ({
  useHostClient: () => ({
    client: { sendRequest: vi.fn(), subscribe: dependencies.subscribe },
    state: 'connected'
  })
}))
vi.mock('./components/use-visible-usage-providers', () => ({
  useVisibleUsageProviders: () => new Set(['antigravity'])
}))
vi.mock('./components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

function limits(): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: Date.now() + 60 * 60_000,
      resetDescription: null
    },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function snapshot(antigravity: ProviderRateLimits | null): AccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      antigravity,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

async function renderRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(AccountsScreen))
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Accounts route did not render')
  }
  return renderer
}

function textValues(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text')
    .map((node) => node.props.children)
    .filter((value): value is string => typeof value === 'string')
}

describe('accounts route display-only providers', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.loadHosts.mockReset().mockResolvedValue([{ id: 'host-1', name: 'Desk' }])
    dependencies.subscribe.mockReset().mockImplementation((_method, _params, emit) => {
      emit({ type: 'ready', snapshot: dependencies.snapshot })
      return vi.fn()
    })
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a visible display-only provider with its dynamic window and reset', async () => {
    dependencies.snapshot = snapshot(limits())
    const renderer = await renderRoute()
    const texts = textValues(renderer)

    expect(texts).toContain('Antigravity')
    expect(texts).toContain('System default')
    expect(texts).toContain('25%')
    expect(texts.some((text) => text.startsWith('Resets in'))).toBe(true)

    act(() => renderer.unmount())
  })

  it('hides a visible display-only provider when the host has no data for it', async () => {
    dependencies.snapshot = snapshot(null)
    const renderer = await renderRoute()

    expect(textValues(renderer)).not.toContain('Antigravity')

    act(() => renderer.unmount())
  })
})
