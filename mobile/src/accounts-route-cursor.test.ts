import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../app/h/[hostId]/accounts'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  loadHosts: vi.fn(),
  sendRequest: vi.fn(),
  snapshot: vi.fn()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    },
    useLocalSearchParams: () => ({ hostId: 'host-1' }),
    useRouter: () => ({ back: dependencies.back })
  }
})

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  User: 'User'
}))

vi.mock('./transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))

vi.mock('./transport/client-context', () => {
  const client = {
    sendRequest: dependencies.sendRequest,
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      onData({ type: 'ready', snapshot: dependencies.snapshot() })
      return vi.fn()
    }
  }
  return { useHostClient: () => ({ client, state: 'connected' }) }
})

vi.mock('./components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

vi.mock('./components/MobileAgentIcon', () => ({
  MobileAgentIcon: 'MobileAgentIcon'
}))

vi.mock('./components/use-codex-reset-credit-action', () => ({
  useCodexResetCreditAction: () => ({
    supported: false,
    resetting: false,
    resetScope: null,
    scopeLabel: null,
    confirmReset: vi.fn()
  })
}))

const HOST_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    cursor: {
      provider: 'cursor',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Cursor Models',
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: Date.parse('2026-09-30T20:01:49Z'),
          resetDescription: 'Sep 30'
        },
        {
          name: 'Other Models',
          usedPercent: 42,
          windowMinutes: 43_200,
          resetsAt: Date.parse('2026-09-30T20:01:49Z'),
          resetDescription: 'Sep 30'
        },
        {
          name: 'Grok Bot',
          usedPercent: 12,
          windowMinutes: 10_080,
          resetsAt: Date.parse('2026-10-04T15:44:42.913Z'),
          resetDescription: 'Oct 4'
        }
      ],
      planType: 'ultra',
      usageMetadata: {
        accountEmail: 'dev@example.com',
        subscriptionStatus: 'active'
      },
      updatedAt: 100,
      error: null,
      status: 'ok'
    },
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  if (typeof node !== 'object') {
    return ''
  }
  const record = node as { children?: unknown; props?: { children?: unknown } }
  return Array.isArray(record.children) && record.children.length > 0
    ? record.children.map(collectText).join('')
    : collectText(record.props?.children)
}

async function renderAccountsRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(AccountsScreen))
    await Promise.resolve()
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Accounts screen did not render')
  }
  return renderer
}

describe('accounts route Cursor usage', () => {
  beforeEach(() => {
    dependencies.loadHosts.mockResolvedValue([
      {
        id: 'host-1',
        name: 'Desk',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        lastConnected: 1
      }
    ])
    dependencies.snapshot.mockReturnValue(HOST_SNAPSHOT)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders read-only Cursor pools and host identity without a mutation request', async () => {
    const renderer = await renderAccountsRoute()
    const text = collectText(renderer.root)

    expect(text).toContain('Cursor Models')
    expect(text).toContain('Other Models')
    expect(text).toContain('Grok Bot')
    expect(text).toContain('dev@example.com')
    expect(text).toContain('ultra · active')
    expect(dependencies.sendRequest).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
