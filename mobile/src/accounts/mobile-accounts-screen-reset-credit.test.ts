import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmModal } from '../components/ConfirmModal'
import { MobileAccountsScreen } from './MobileAccountsScreen'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  loadHosts: vi.fn(),
  uuid: vi.fn<() => string>(),
  resetRequest: vi.fn(),
  selectRequest: vi.fn(),
  statusCapabilities: vi.fn(),
  subscriptionListeners: new Array<(payload: unknown) => void>()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
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
    useLocalSearchParams: () => ({ hostId: 'host-1' })
  }
})

// The page's Back: the handoff pops the shell's stack, where expo-router's own `back()` goes nowhere.
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: dependencies.back })
}))

// The dialogs are read off `ConfirmModal`'s props; the drawer under them needs a native runtime.
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('../platform/random-v4-uuid', () => ({ randomV4Uuid: dependencies.uuid }))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User'
}))

vi.mock('../transport/hosts/host-store', () => ({
  loadHosts: dependencies.loadHosts,
  peekHosts: () => null
}))

vi.mock('../transport/connection/host-client-hooks', () => {
  const client = {
    sendRequest: async (method: string, params?: unknown, options?: unknown) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { capabilities: dependencies.statusCapabilities() },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'accounts.consumeCodexResetCredit') {
        return dependencies.resetRequest(params, options)
      }
      if (
        method === 'accounts.selectCodex' ||
        method === 'accounts.selectCodexForTarget' ||
        method === 'accounts.selectClaude'
      ) {
        return dependencies.selectRequest(method, params)
      }
      if (method === 'accounts.list') {
        return { id: 'list', ok: true, result: AVAILABLE_SNAPSHOT }
      }
      throw new Error(`Unexpected request: ${method}`)
    },
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      dependencies.subscriptionListeners.push(onData)
      onData({ type: 'ready', snapshot: AVAILABLE_SNAPSHOT })
      return vi.fn()
    }
  }
  return {
    useForceReconnect: () => null,
    useHostClient: () => ({ client, state: 'connected' })
  }
})

vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

const AVAILABLE_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: {
    accounts: [
      {
        id: 'codex-1',
        email: 'dev@example.com',
        managedHomeRuntime: 'host',
        wslDistro: null,
        updatedAt: 10
      }
    ],
    activeAccountId: 'codex-1',
    activeAccountIdsByRuntime: { host: 'codex-1', wsl: {} }
  },
  rateLimits: {
    claude: null,
    codex: {
      provider: 'codex',
      session: {
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: 2_000_000_000_000,
        resetDescription: null
      },
      weekly: null,
      rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null },
      updatedAt: 100,
      error: null,
      status: 'ok'
    },
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
} as const

const RESET_SNAPSHOT = {
  ...AVAILABLE_SNAPSHOT,
  rateLimits: {
    ...AVAILABLE_SNAPSHOT.rateLimits,
    codex: {
      ...AVAILABLE_SNAPSHOT.rateLimits.codex,
      session: { ...AVAILABLE_SNAPSHOT.rateLimits.codex.session, usedPercent: 0 },
      rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null },
      updatedAt: 101
    }
  }
} as const

async function renderAccountsRoute(): Promise<ReactTestRenderer> {
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

/** Host components are strings under the mock above, so they are found by what they carry. */
function pressables(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  )
}

function resetButtons(renderer: ReactTestRenderer) {
  return pressables(renderer, 'Use Codex rate-limit reset')
}

async function findResetButton(renderer: ReactTestRenderer) {
  await vi.waitFor(() => expect(resetButtons(renderer)).toHaveLength(1))
  return resetButtons(renderer)[0]!
}

/** The open dialog, read off `ConfirmModal` the way a user reads the drawer. */
function openDialog(renderer: ReactTestRenderer) {
  const open = renderer.root
    .findAllByType(ConfirmModal)
    .map((node) => node.props)
    .filter((props) => props.visible)
  if (open.length > 1) {
    throw new Error(`expected at most one open dialog, found ${open.length}`)
  }
  return open[0] ?? null
}

/** Presses the dialog's confirm button, which closes it after its action as `ConfirmContent` does. */

const KEY = '11111111-1111-4111-8111-111111111111'

describe('accounts route Codex reset credit', () => {
  beforeEach(() => {
    dependencies.loadHosts.mockReset().mockResolvedValue([
      {
        id: 'host-1',
        name: 'Desk',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        lastConnected: 1
      }
    ])
    dependencies.uuid.mockReset().mockReturnValue(KEY)
    dependencies.back.mockReset()
    dependencies.statusCapabilities.mockReset().mockReturnValue(['accounts.codex-reset-credit.v1'])
    dependencies.resetRequest.mockReset().mockImplementation((params) => ({
      id: 'reset',
      ok: true,
      result: {
        outcome: 'reset',
        scope: (params as { expectedScope: unknown }).expectedScope,
        snapshot: RESET_SNAPSHOT
      },
      _meta: { runtimeId: 'runtime-1' }
    }))
    dependencies.selectRequest.mockReset().mockResolvedValue({
      id: 'select',
      ok: true,
      result: AVAILABLE_SNAPSHOT.codex
    })
    dependencies.subscriptionListeners.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const renderer = await renderAccountsRoute()
    const button = await findResetButton(renderer)
    await act(async () => button.props.onPress())
    act(() => openDialog(renderer)?.onCancel())

    expect(openDialog(renderer)).toBeNull()
    expect(dependencies.resetRequest).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
