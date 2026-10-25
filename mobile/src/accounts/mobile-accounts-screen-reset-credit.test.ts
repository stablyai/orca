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
    useLocalSearchParams: () => ({ hostId: 'host-1' })
  }
})

// The page's Back: the handoff pops the shell's stack, where expo-router's own `back()` goes nowhere.
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: dependencies.back })
}))

// The dialogs are read off `ConfirmModal`'s props; the drawer under them needs a native runtime.
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('../platform/random-v4-uuid', () => ({ randomV4Uuid: dependencies.uuid }))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User'
}))

vi.mock('../transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))

vi.mock('../transport/host-client-hooks', () => {
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

function systemDefaultButtons(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' &&
      node
        .findAll((child) => String(child.type) === 'Text')
        .some((textNode) => textNode.children.join('') === 'System default')
  )
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
function getLatestConfirmAction(renderer: ReactTestRenderer): () => void {
  const dialog = openDialog(renderer)
  if (dialog?.title !== 'Use a rate-limit reset?') {
    throw new Error('Reset confirmation not open')
  }
  return () => {
    dialog.onConfirm()
    dialog.onCancel()
  }
}

async function confirmReset(renderer: ReactTestRenderer): Promise<void> {
  const button = await findResetButton(renderer)
  await act(async () => button.props.onPress())
  const confirm = getLatestConfirmAction(renderer)
  await act(async () => {
    confirm()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function expectNotice(renderer: ReactTestRenderer, title: string, message: string): void {
  expect(openDialog(renderer)).toMatchObject({ title, message, cancelLabel: null })
}

function dismissNotice(renderer: ReactTestRenderer): void {
  act(() => openDialog(renderer)?.onCancel())
}

const KEY = '11111111-1111-4111-8111-111111111111'
const SECOND_KEY = '22222222-2222-4222-8222-222222222222'

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

  it('retries a lost reply under a new key and shows the outcome the host recorded', async () => {
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
    expectNotice(firstRenderer, 'Could not reset rate limits', 'Connection lost')
    act(() => firstRenderer.unmount())

    dependencies.uuid.mockReturnValue(SECOND_KEY)
    const secondRenderer = await renderAccountsRoute()
    await confirmReset(secondRenderer)

    // No journal on the phone, as on the desktop: a new key, the same offer, and the host's ledger
    // answers it with the attempt it recorded.
    expect(dependencies.resetRequest).toHaveBeenCalledTimes(2)
    const [firstParams, firstOptions] = dependencies.resetRequest.mock.calls[0]!
    const [secondParams, secondOptions] = dependencies.resetRequest.mock.calls[1]!
    expect(firstParams).toMatchObject({ idempotencyKey: KEY })
    expect(secondParams).toMatchObject({ idempotencyKey: SECOND_KEY })
    expect(secondParams.expectedScope).toEqual(firstParams.expectedScope)
    expect(firstOptions).toEqual({ timeoutMs: 90_000 })
    expect(secondOptions).toEqual({ timeoutMs: 90_000 })
    expectNotice(secondRenderer, 'Reset already applied', 'Codex usage has been refreshed.')
    act(() => secondRenderer.unmount())
  })

  it('shows the resumed outcome when the offer moved after a lost reply', async () => {
    dependencies.resetRequest.mockRejectedValueOnce(new Error('Connection lost'))
    const renderer = await renderAccountsRoute()
    await confirmReset(renderer)
    expectNotice(renderer, 'Could not reset rate limits', 'Connection lost')
    dismissNotice(renderer)
    const [firstParams] = dependencies.resetRequest.mock.calls[0]!

    // The host refreshes usage after an unknown outcome, which moves the offer the phone sees.
    const refreshed = {
      ...AVAILABLE_SNAPSHOT,
      rateLimits: {
        ...AVAILABLE_SNAPSHOT.rateLimits,
        codex: { ...AVAILABLE_SNAPSHOT.rateLimits.codex, updatedAt: 101 }
      }
    }
    act(() => {
      dependencies.subscriptionListeners[0]?.({ type: 'snapshot', snapshot: refreshed })
    })
    // The host resumes the account's unresolved attempt and answers with that attempt's scope.
    dependencies.uuid.mockReturnValue(SECOND_KEY)
    dependencies.resetRequest.mockImplementationOnce(() => ({
      id: 'reset-2',
      ok: true,
      result: { outcome: 'reset', scope: firstParams.expectedScope, snapshot: RESET_SNAPSHOT },
      _meta: { runtimeId: 'runtime-1' }
    }))
    await confirmReset(renderer)

    const [secondParams] = dependencies.resetRequest.mock.calls[1]!
    expect(secondParams).toMatchObject({ idempotencyKey: SECOND_KEY })
    expect(secondParams.expectedScope.offerRevision).not.toBe(
      firstParams.expectedScope.offerRevision
    )
    expectNotice(renderer, 'Rate limits reset', 'Codex usage has been refreshed.')
    act(() => renderer.unmount())
  })

  it('keeps the exact confirmed scope when a subscription changes before confirmation', async () => {
    const renderer = await renderAccountsRoute()
    const button = await findResetButton(renderer)
    await act(async () => button.props.onPress())
    const action = getLatestConfirmAction(renderer)

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
    expectNotice(
      renderer,
      'Reset details changed',
      'The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.'
    )
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

  it('recovers from key generation failure without leaving the action busy', async () => {
    dependencies.uuid.mockImplementationOnce(() => {
      throw new Error('Random bytes unavailable')
    })
    const renderer = await renderAccountsRoute()

    await confirmReset(renderer)
    expectNotice(renderer, 'Could not reset rate limits', 'Random bytes unavailable')
    dismissNotice(renderer)
    expect((await findResetButton(renderer)).props.accessibilityState).toEqual({
      busy: false,
      disabled: false
    })

    await confirmReset(renderer)
    expect(dependencies.resetRequest).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
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

  it('puts a failed switch on screen, where Alert would be a no-op on the page', async () => {
    dependencies.selectRequest.mockResolvedValue({
      id: 'select',
      ok: false,
      error: { code: 'internal', message: 'Desktop refused the switch' }
    })
    const renderer = await renderAccountsRoute()
    await act(async () => {
      await systemDefaultButtons(renderer)[0]?.props.onPress()
    })

    expectNotice(renderer, 'Could not switch account', 'Desktop refused the switch')
    dismissNotice(renderer)
    expect(openDialog(renderer)).toBeNull()
    act(() => renderer.unmount())
  })

  it('leaves through the route handoff, which pops the shell from inside the page', async () => {
    const renderer = await renderAccountsRoute()
    const back = pressables(renderer, 'Back')
    expect(back).toHaveLength(1)
    act(() => back[0]?.props.onPress())

    expect(dependencies.back).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })
})
