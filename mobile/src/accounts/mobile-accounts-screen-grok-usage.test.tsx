import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileAccountsScreen } from './MobileAccountsScreen'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const dependencies = vi.hoisted(() => ({
  snapshot: null as unknown
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Pressable: 'Pressable',
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
    useLocalSearchParams: () => ({ hostId: 'host-1' })
  }
})

vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: vi.fn() })
}))

vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('../platform/random-v4-uuid', () => ({
  randomV4Uuid: () => '00000000-0000-4000-8000-000000000000'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User'
}))

vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [{ id: 'host-1', name: 'Desk' }]
}))

vi.mock('../transport/host-client-hooks', () => {
  const client = {
    sendRequest: async () => ({ id: 'list', ok: true, result: dependencies.snapshot }),
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      onData({ type: 'ready', snapshot: dependencies.snapshot })
      return () => {}
    }
  }
  return { useHostClient: () => ({ client, state: 'connected' }) }
})

vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

function snapshot(grok: unknown) {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      grokAuthConfigured: grok !== null,
      grok
    }
  }
}

function grokLimits(window: 'weekly' | 'monthly') {
  return {
    provider: 'grok',
    session: null,
    weekly:
      window === 'weekly'
        ? { usedPercent: 42, windowMinutes: 10080, resetsAt: null, resetDescription: 'Thu' }
        : null,
    monthly:
      window === 'monthly'
        ? { usedPercent: 18, windowMinutes: 43200, resetsAt: null, resetDescription: null }
        : null,
    updatedAt: 100,
    error: null,
    status: 'ok',
    usageMetadata: { authProvenance: 'Grok CLI session' }
  }
}

function visibleText(renderer: ReactTestRenderer): string[] {
  return findAllByHostType(renderer.root, 'Text').map((node) =>
    node.children.filter((child): child is string => typeof child === 'string').join('')
  )
}

async function renderAccounts(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(MobileAccountsScreen))
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Accounts route did not render')
  }
  return renderer
}

describe('mobile accounts Grok usage', () => {
  it('shows weekly credit usage from the host snapshot', async () => {
    dependencies.snapshot = snapshot(grokLimits('weekly'))
    const renderer = await renderAccounts()

    expect(visibleText(renderer)).toEqual(
      expect.arrayContaining(['Grok', 'Weekly credits', 'Grok CLI session', 'wk', '42%'])
    )
    act(() => renderer.unmount())
  })

  it('shows monthly usage when the account has no weekly credits', async () => {
    dependencies.snapshot = snapshot(grokLimits('monthly'))
    const renderer = await renderAccounts()
    const text = visibleText(renderer)

    expect(text).toEqual(expect.arrayContaining(['Monthly usage', 'mo', '18%']))
    expect(text).not.toContain('Weekly credits')
    act(() => renderer.unmount())
  })

  it('omits Grok when the host has no CLI session and no usage', async () => {
    dependencies.snapshot = snapshot(null)
    const renderer = await renderAccounts()

    expect(visibleText(renderer)).not.toContain('Grok')
    act(() => renderer.unmount())
  })
})
