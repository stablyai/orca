import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../app/h/[hostId]/accounts'
import { resetCodexResetAttemptJournalForTests } from './storage/codex-reset-attempt-journal'

const dependencies = vi.hoisted(() => ({
  alert: vi.fn(),
  back: vi.fn(),
  loadHosts: vi.fn(),
  randomUUID: vi.fn(),
  resetRequest: vi.fn(),
  selectRequest: vi.fn(),
  statusCapabilities: vi.fn(),
  subscriptionListeners: [] as Array<(payload: unknown) => void>,
  asyncStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: dependencies.asyncStorage
}))

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
    useRouter: () => ({ back: dependencies.back })
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

vi.mock('./transport/client-context', () => {
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
    useHostClient: () => ({ client, state: 'connected' })
  }
})

vi.mock('./components/AgentIcons', () => ({
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

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

async function renderAccountsRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(AccountsScreen))
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('Accounts route did not render')
  }
  return renderer
}

function resetButtons(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable')
    .filter((node) => node.props.accessibilityLabel === 'Use Codex rate-limit reset')
}

function systemDefaultButtons(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable')
    .filter((node) =>
      node.findAllByType('Text').some((textNode) => textNode.children.join('') === 'System default')
    )
}

async function findResetButton(renderer: ReactTestRenderer) {
  await vi.waitFor(() => expect(resetButtons(renderer)).toHaveLength(1))
  return resetButtons(renderer)[0]!
}

function getLatestConfirmAction(): () => void {
  const call = dependencies.alert.mock.calls
    .toReversed()
    .find(([title]) => title === 'Use a rate-limit reset?')
  const action = call?.[2]?.[1]?.onPress
  if (typeof action !== 'function') {
    throw new Error('Reset confirmation action not found')
  }
  return action
}

async function confirmReset(renderer: ReactTestRenderer): Promise<void> {
  const button = await findResetButton(renderer)
  await act(async () => button.props.onPress())
  await act(async () => {
    getLatestConfirmAction()()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('accounts route Codex reset credit', () => {
  let storedValues: Map<string, string>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetCodexResetAttemptJournalForTests()
    storedValues = new Map()
    dependencies.alert.mockReset()
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
    dependencies.randomUUID.mockReset().mockReturnValue('11111111-1111-4111-8111-111111111111')
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
    dependencies.asyncStorage.getItem
      .mockReset()
      .mockImplementation(async (key: string) => storedValues.get(key) ?? null)
    dependencies.asyncStorage.setItem
      .mockReset()
      .mockImplementation(async (key: string, value: string) => {
        storedValues.set(key, value)
      })
    dependencies.asyncStorage.removeItem.mockReset().mockImplementation(async (key: string) => {
      storedValues.delete(key)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hides the scarce action when an older host does not advertise the capability', async () => {
    dependencies.statusCapabilities.mockReturnValue([])
    const renderer = await renderAccountsRoute()
    await act(async () => {
      await Promise.resolve()
    })

    expect(resetButtons(renderer)).toHaveLength(0)
    expect(dependencies.resetRequest).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('persists before RPC and reuses the UUID after unmounting an ambiguous request', async () => {
    dependencies.resetRequest
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockImplementationOnce((params) => ({
        id: 'reset-2',
        ok: true,
        result: {
          outcome: 'alreadyRedeemed',
          scope: (params as { expectedScope: unknown }).expectedScope,
          snapshot: RESET_SNAPSHOT
        },
        _meta: { runtimeId: 'runtime-1' }
      }))

    const firstRenderer = await renderAccountsRoute()
    await confirmReset(firstRenderer)
    expect(dependencies.alert).toHaveBeenCalledWith(
      'Could not reset rate limits',
      'Connection lost'
    )
    expect(storedValues.size).toBe(1)
    act(() => firstRenderer.unmount())

    resetCodexResetAttemptJournalForTests()
    const secondRenderer = await renderAccountsRoute()
    await confirmReset(secondRenderer)

    expect(dependencies.randomUUID).toHaveBeenCalledTimes(1)
    expect(dependencies.resetRequest).toHaveBeenCalledTimes(2)
    const [firstParams, firstOptions] = dependencies.resetRequest.mock.calls[0]!
    const [secondParams, secondOptions] = dependencies.resetRequest.mock.calls[1]!
    expect(firstParams).toEqual(secondParams)
    expect(firstOptions).toEqual({ timeoutMs: 90_000 })
    expect(secondOptions).toEqual({ timeoutMs: 90_000 })
    expect(storedValues.size).toBe(0)
    expect(dependencies.alert).toHaveBeenCalledWith(
      'Reset already applied',
      'Codex usage has been refreshed.'
    )
    act(() => secondRenderer.unmount())
  })

  it('keeps the exact confirmed scope when a subscription changes before confirmation', async () => {
    const renderer = await renderAccountsRoute()
    const button = await findResetButton(renderer)
    await act(async () => button.props.onPress())
    const action = getLatestConfirmAction()

    const changedSnapshot = {
      ...AVAILABLE_SNAPSHOT,
      codex: {
        ...AVAILABLE_SNAPSHOT.codex,
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      }
    }
    dependencies.resetRequest.mockImplementation((params) => ({
      id: 'reset',
      ok: true,
      result: {
        status: 'rejectedBeforeProvider',
        retryDisposition: 'discardAttempt',
        reason: 'accountChanged',
        scope: (params as { expectedScope: unknown }).expectedScope,
        snapshot: changedSnapshot
      },
      _meta: { runtimeId: 'runtime-1' }
    }))
    act(() => {
      dependencies.subscriptionListeners[0]?.({ type: 'snapshot', snapshot: changedSnapshot })
    })
    await act(async () => {
      action()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.resetRequest).toHaveBeenCalledOnce()
    expect(dependencies.resetRequest.mock.calls[0]?.[0]).toMatchObject({
      expectedScope: { accountId: 'codex-1', accountRevision: 10 }
    })
    expect(dependencies.alert).toHaveBeenCalledWith(
      'Reset details changed',
      'The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.'
    )
    expect(storedValues.size).toBe(0)
    act(() => renderer.unmount())
  })

  it('passes the active WSL target when clearing the Codex selection', async () => {
    const renderer = await renderAccountsRoute()
    const wslSnapshot = {
      ...AVAILABLE_SNAPSHOT,
      codex: {
        accounts: [
          {
            ...AVAILABLE_SNAPSHOT.codex.accounts[0],
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu'
          }
        ],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'codex-1' } }
      },
      rateLimits: {
        ...AVAILABLE_SNAPSHOT.rateLimits,
        codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      }
    } as const

    act(() => {
      dependencies.subscriptionListeners[0]?.({ type: 'snapshot', snapshot: wslSnapshot })
    })
    const codexSystemDefault = systemDefaultButtons(renderer).at(-1)
    expect(codexSystemDefault).toBeDefined()

    await act(async () => {
      await codexSystemDefault?.props.onPress()
    })

    expect(dependencies.selectRequest).toHaveBeenCalledWith('accounts.selectCodexForTarget', {
      accountId: null,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    act(() => renderer.unmount())
  })

  it('recovers from UUID generation failure without leaving the action busy', async () => {
    dependencies.randomUUID
      .mockImplementationOnce(() => {
        throw new Error('UUID unavailable')
      })
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
    const renderer = await renderAccountsRoute()

    await confirmReset(renderer)
    expect(dependencies.alert).toHaveBeenCalledWith(
      'Could not reset rate limits',
      'UUID unavailable'
    )
    expect((await findResetButton(renderer)).props.accessibilityState).toEqual({
      busy: false,
      disabled: false
    })

    await confirmReset(renderer)
    expect(dependencies.resetRequest).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })
})
