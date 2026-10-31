import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY } from '../../../src/shared/account-runtime-capabilities'
import { MobileAccountsScreen } from './MobileAccountsScreen'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const OPENCODE_ACCOUNT = '11111111-1111-4111-8111-111111111111'

const dependencies = vi.hoisted(() => ({
  snapshot: null as unknown,
  capabilities: [] as string[],
  antigravity: null as unknown,
  requests: [] as Array<{ method: string; params: unknown }>
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
    sendRequest: async (method: string, params?: unknown) => {
      dependencies.requests.push({ method, params })
      if (method === 'status.get') {
        return { id: 'status', ok: true, result: { capabilities: dependencies.capabilities } }
      }
      if (method === 'accounts.antigravityList' || method === 'accounts.antigravitySelect') {
        return { id: method, ok: true, result: dependencies.antigravity }
      }
      return { id: method, ok: true, result: dependencies.snapshot }
    },
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      onData({ type: 'ready', snapshot: dependencies.snapshot })
      return () => {}
    }
  }
  return { useHostClient: () => ({ client, state: 'connected' }) }
})

vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon',
  MiniMaxIcon: 'MiniMaxIcon',
  OpenCodeGoIcon: 'OpenCodeGoIcon'
}))

vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

function limitWindow(usedPercent: number, windowMinutes: number) {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function snapshot(): unknown {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    opencode: {
      accounts: [
        {
          id: OPENCODE_ACCOUNT,
          label: 'Work',
          integrations: ['github'],
          createdAt: 10
        }
      ],
      activeAccountId: null
    },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      gemini: {
        provider: 'gemini',
        session: null,
        weekly: null,
        buckets: [
          { ...limitWindow(15, 10080), name: 'Flash' },
          { ...limitWindow(90, 10080), name: 'Experimental' }
        ],
        updatedAt: 1,
        error: null,
        status: 'ok'
      },
      opencodeGo: {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        monthly: limitWindow(33, 43200),
        updatedAt: 1,
        error: null,
        status: 'ok'
      },
      zcode: {
        provider: 'zcode',
        session: limitWindow(10, 300),
        weekly: limitWindow(20, 10080),
        monthly: limitWindow(30, 43200),
        updatedAt: 1,
        error: null,
        status: 'ok'
      },
      grok: null,
      grokAuthConfigured: false
    }
  }
}

function visibleText(renderer: ReactTestRenderer): string[] {
  return findAllByHostType(renderer.root, 'Text').map((node) =>
    node.children.filter((child): child is string => typeof child === 'string').join('')
  )
}

function pressLabeled(renderer: ReactTestRenderer, label: string): void {
  const pressable = findAllByHostType(renderer.root, 'Pressable').find((node) =>
    findAllByHostType(node, 'Text').some((text) => text.children.includes(label))
  )
  if (!pressable || typeof pressable.props.onPress !== 'function') {
    throw new Error(`No pressable for ${label}`)
  }
  pressable.props.onPress()
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

describe('mobile accounts for desktop providers', () => {
  it('shows configured desktop providers and can select a managed OpenCode account', async () => {
    dependencies.snapshot = snapshot()
    dependencies.capabilities = []
    dependencies.requests = []
    const renderer = await renderAccounts()
    const text = visibleText(renderer)

    expect(text).toEqual(
      expect.arrayContaining([
        'OpenCode',
        'Work',
        'github',
        'Gemini',
        'Flash',
        '15%',
        'OpenCode Go',
        'mo',
        '33%',
        'GLM Coding Plan',
        '5h',
        'wk',
        'MCP monthly',
        '30%'
      ])
    )
    expect(text).not.toContain('Experimental')
    expect(text).not.toContain('MiniMax')
    expect(text).not.toContain('Devin')
    expect(text).not.toContain('Grok')

    await act(async () => {
      pressLabeled(renderer, 'Work')
      await Promise.resolve()
    })

    expect(dependencies.requests).toContainEqual({
      method: 'accounts.selectData',
      params: { provider: 'opencode', accountId: OPENCODE_ACCOUNT }
    })
    act(() => renderer.unmount())
  })

  it('lists saved Antigravity accounts only after the host advertises that capability', async () => {
    dependencies.snapshot = {
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: {
        claude: null,
        codex: null,
        claudeTarget: { runtime: 'host', wslDistro: null },
        codexTarget: { runtime: 'host', wslDistro: null },
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    }
    dependencies.antigravity = {
      accounts: [
        {
          id: 'agy-1',
          email: 'ada@example.com',
          subject: null,
          authMethod: 'oauth',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activeAccountId: 'agy-1',
      currentAccount: {
        email: 'ada@example.com',
        subject: null,
        authMethod: 'oauth',
        identityKnown: true
      },
      selectedAccountId: 'agy-1'
    }
    dependencies.capabilities = []
    dependencies.requests = []
    const hidden = await renderAccounts()
    await vi.waitFor(() => {
      expect(dependencies.requests.some((request) => request.method === 'status.get')).toBe(true)
    })
    expect(visibleText(hidden)).not.toContain('Antigravity')
    expect(
      dependencies.requests.some((request) => request.method === 'accounts.antigravityList')
    ).toBe(false)
    act(() => hidden.unmount())

    dependencies.capabilities = [ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY]
    dependencies.requests = []
    const shown = await renderAccounts()
    await vi.waitFor(() => {
      expect(visibleText(shown)).toContain('ada@example.com')
    })
    expect(visibleText(shown)).toContain('Antigravity')
    expect(dependencies.requests).toContainEqual({
      method: 'accounts.antigravityList',
      params: { runtime: 'host' }
    })
    act(() => shown.unmount())
  })
})
