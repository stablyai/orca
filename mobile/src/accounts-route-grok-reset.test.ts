import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../app/h/[hostId]/accounts'
import { resetGrokResetAttemptJournalForTests } from './storage/grok-reset-attempt-journal'

const dependencies = vi.hoisted(() => ({
  alert: vi.fn(),
  loadHosts: vi.fn(),
  randomUUID: vi.fn(),
  grokResetRequest: vi.fn(),
  statusCapabilities: vi.fn(),
  asyncStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: dependencies.asyncStorage }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: dependencies.alert },
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
    useRouter: () => ({ back: vi.fn() })
  }
})
vi.mock('expo-crypto', () => ({ randomUUID: dependencies.randomUUID }))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User'
}))
vi.mock('./transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))
vi.mock('./components/AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))
vi.mock('./components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

const HOST_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    grok: {
      provider: 'grok',
      session: null,
      weekly: {
        usedPercent: 13,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-09-03T12:58:43Z'),
        resetDescription: null
      },
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: Date.parse('2026-09-12T18:49:00Z')
      },
      usageMetadata: { authProvenance: 'dev@example.com (SuperGrok Heavy)' },
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

const RESET_SNAPSHOT = {
  ...HOST_SNAPSHOT,
  rateLimits: {
    ...HOST_SNAPSHOT.rateLimits,
    grok: {
      ...HOST_SNAPSHOT.rateLimits.grok,
      weekly: { ...HOST_SNAPSHOT.rateLimits.grok.weekly, usedPercent: 0 },
      rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null }
    }
  }
}

vi.mock('./transport/client-context', () => {
  const client = {
    sendRequest: async (method: string, params?: unknown) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: dependencies.statusCapabilities() } }
      }
      if (method === 'accounts.consumeGrokResetCredit') {
        return dependencies.grokResetRequest(params)
      }
      if (method === 'accounts.list') {
        return { ok: true, result: HOST_SNAPSHOT }
      }
      throw new Error(`Unexpected request: ${method}`)
    },
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      onData({ type: 'ready', snapshot: HOST_SNAPSHOT })
      return vi.fn()
    }
  }
  return { useHostClient: () => ({ client, state: 'connected' }) }
})

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
  if (Array.isArray(record.children) && record.children.length > 0) {
    return record.children.map(collectText).join('')
  }
  return collectText(record.props?.children)
}

async function renderRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(AccountsScreen))
    await Promise.resolve()
    await Promise.resolve()
  })
  return renderer!
}

function grokResetButtons(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable')
    .filter((node) => node.props.accessibilityLabel === 'Use Grok rate-limit reset')
}

describe('accounts route Grok reset', () => {
  let stored: string | null

  beforeEach(() => {
    stored = null
    resetGrokResetAttemptJournalForTests()
    dependencies.alert.mockReset()
    dependencies.loadHosts.mockResolvedValue([{ id: 'host-1', name: 'Desk' }])
    dependencies.randomUUID.mockReturnValue('22222222-2222-4222-8222-222222222222')
    dependencies.statusCapabilities.mockReturnValue(['accounts.grok-reset-credit.v1'])
    dependencies.grokResetRequest.mockResolvedValue({
      ok: true,
      result: { outcome: 'reset', snapshot: RESET_SNAPSHOT }
    })
    dependencies.asyncStorage.getItem.mockImplementation(async () => stored)
    dependencies.asyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    dependencies.asyncStorage.removeItem.mockImplementation(async () => {
      stored = null
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('shows Grok usage but hides redemption for an old host without the capability', async () => {
    dependencies.statusCapabilities.mockReturnValue([])
    const renderer = await renderRoute()
    await vi.waitFor(() => expect(dependencies.statusCapabilities).toHaveBeenCalled())

    expect(collectText(renderer.root)).toContain('dev@example.com (SuperGrok Heavy)')
    expect(grokResetButtons(renderer)).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('confirms and redeems with only the attempt UUID', async () => {
    const renderer = await renderRoute()
    await vi.waitFor(() => expect(grokResetButtons(renderer)).toHaveLength(1))
    act(() => grokResetButtons(renderer)[0]!.props.onPress())
    const confirm = dependencies.alert.mock.calls.find(
      ([title]) => title === 'Use a rate-limit reset?'
    )
    const action = confirm?.[2]?.find((item: { text: string }) => item.text === 'Use reset')
    await act(async () => {
      action?.onPress?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.grokResetRequest).toHaveBeenCalledWith({
      idempotencyKey: '22222222-2222-4222-8222-222222222222'
    })
    expect(JSON.stringify(dependencies.grokResetRequest.mock.calls)).not.toMatch(/restok_/)
    act(() => renderer.unmount())
  })
})
