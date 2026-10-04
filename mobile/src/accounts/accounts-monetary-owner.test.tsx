import { createElement } from 'react'
import { Text, ScrollView } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../../app/h/[hostId]/accounts'
import {
  deepSeekMobileSnapshot,
  MOBILE_DEEPSEEK_LIMITS
} from '../test-support/deepseek-balance-snapshot'

const boundary = vi.hoisted(() => {
  const streams: Array<(payload: unknown) => void> = []
  return {
    hostId: 'a',
    clientId: 'client-a',
    generation: 1,
    state: 'connected',
    streams,
    states: new Set<() => void>(),
    request: vi.fn(),
    loadHosts: vi.fn()
  }
})
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  RefreshControl: 'RefreshControl',
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (value: unknown) => value },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0 })
}))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useLocalSearchParams: () => ({ hostId: boundary.hostId }),
    useRouter: () => ({ back() {} }),
    useFocusEffect: (effect: () => (() => void) | void) => React.useEffect(effect, [effect])
  }
})
vi.mock('lucide-react-native', () => ({
  Coins: 'Coins',
  ChevronLeft: 'ChevronLeft',
  Check: 'Check',
  RefreshCw: 'RefreshCw',
  User: 'User'
}))
vi.mock('../components/AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))
vi.mock('../transport/host-store', () => ({ loadHosts: boundary.loadHosts }))
vi.mock('../components/use-codex-reset-credit-action', () => ({
  useCodexResetCreditAction: () => ({ supported: false, resetting: false, resetScope: null })
}))
vi.mock('../transport/client-context', () => {
  const client = {
    getGeneration: () => boundary.generation,
    onStateChange: (listener: () => void) => {
      boundary.states.add(listener)
      return () => boundary.states.delete(listener)
    },
    subscribe: (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
      boundary.streams.push(listener)
      return () => {}
    },
    sendRequest: boundary.request
  }
  return { useHostClient: () => ({ client, clientId: boundary.clientId, state: boundary.state }) }
})

function balance(amount: string) {
  return deepSeekMobileSnapshot({
    deepseek: {
      ...MOBILE_DEEPSEEK_LIMITS,
      balance: {
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: amount,
            granted_balance: '0',
            topped_up_balance: amount
          }
        ]
      }
    }
  })
}
let renderer: ReactTestRenderer | null = null
const paint = () =>
  renderer?.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .join(' ')
const emit = (listener: (payload: unknown) => void, amount: string) =>
  act(() => listener({ type: 'snapshot', snapshot: balance(amount) }))

beforeEach(() => {
  boundary.hostId = 'a'
  boundary.clientId = 'client-a'
  boundary.generation = 1
  boundary.state = 'connected'
  boundary.streams.length = 0
  boundary.states.clear()
  boundary.request.mockReset()
  boundary.loadHosts.mockResolvedValue([
    { id: 'a', name: 'Host A' },
    { id: 'b', name: 'Host B' }
  ])
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
async function mount() {
  await act(async () => {
    renderer = create(createElement(AccountsScreen))
  })
}
async function repaint() {
  await act(async () => {
    renderer?.update(createElement(AccountsScreen))
  })
}

describe('Accounts monetary execution host ownership', () => {
  it('retires A, B, then A snapshots and ignores callbacks from both retired mounts', async () => {
    await mount()
    const a = boundary.streams[0]!
    emit(a, '11.1100')
    expect(paint()).toContain('11.1100')
    boundary.hostId = 'b'
    boundary.clientId = 'client-b'
    await repaint()
    expect(paint()).not.toContain('11.1100')
    const b = boundary.streams[1]!
    emit(b, '22.2200')
    emit(a, '99.9900')
    expect(paint()).toContain('22.2200')
    expect(paint()).not.toContain('99.9900')
    boundary.hostId = 'a'
    boundary.clientId = 'client-a'
    await repaint()
    emit(b, '88.8800')
    expect(paint()).not.toContain('22.2200')
    expect(paint()).not.toContain('88.8800')
    emit(boundary.streams[2]!, '33.3300')
    expect(paint()).toContain('33.3300')
  })
  it('retires a balance on disconnect and on a logical cutover that stays connected', async () => {
    await mount()
    emit(boundary.streams[0]!, '11.1100')
    boundary.state = 'disconnected'
    await repaint()
    expect(paint()).not.toContain('11.1100')
    boundary.state = 'connected'
    await repaint()
    emit(boundary.streams[1]!, '22.2200')
    await act(async () => {
      boundary.generation += 1
      for (const listener of boundary.states) {
        listener()
      }
    })
    expect(paint()).not.toContain('22.2200')
    emit(boundary.streams[2]!, '33.3300')
    expect(paint()).toContain('33.3300')
  })
  it('does not paint a late refresh from a retired host, and refresh uses the real forced lane', async () => {
    await mount()
    emit(boundary.streams[0]!, '11.1100')
    let finish: (value: unknown) => void = () => {}
    boundary.request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const control = renderer?.root.findByType(ScrollView).props.refreshControl
    act(() => {
      void control?.props.onRefresh()
    })
    expect(boundary.request).toHaveBeenCalledWith('accounts.list')
    boundary.hostId = 'b'
    boundary.clientId = 'client-b'
    await repaint()
    await act(async () => {
      finish({ ok: true, result: balance('99.9900') })
    })
    expect(paint()).not.toContain('99.9900')
  })
})

it.each(['replacement', 'malformed'] as const)(
  'rejects both pending Accounts refreshes after a newer %s push, then accepts a fresh read',
  async (kind) => {
    await mount()
    emit(boundary.streams[0]!, '11.1100')
    const replies: Array<(reply: unknown) => void> = []
    boundary.request.mockImplementation(() => new Promise((resolve) => replies.push(resolve)))
    const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
    act(() => {
      void refresh()
      void refresh()
    })
    const newer =
      kind === 'malformed'
        ? {}
        : deepSeekMobileSnapshot({
            deepseek: null,
            deepseekAccount: {
              supported: true,
              configured: true,
              ownerId: 'replacement',
              protection: 'sealed'
            }
          })
    act(() => boundary.streams[0]!({ type: 'snapshot', snapshot: newer }))
    await act(async () => {
      replies[1]!({ ok: true, result: balance('22.2200') })
      replies[0]!({ ok: true, result: balance('11.1100') })
    })
    expect(paint()).not.toContain('11.1100')
    expect(paint()).not.toContain('22.2200')
    act(() => {
      void refresh()
    })
    await act(async () => replies[2]!({ ok: true, result: balance('33.3300') }))
    expect(paint()).toContain('33.3300')
  }
)

it.each(['older-first', 'newer-first'] as const)(
  'keeps the newer Accounts read when overlapping replies settle %s',
  async (order) => {
    await mount()
    const replies: Array<(reply: unknown) => void> = []
    boundary.request.mockImplementation(() => new Promise((resolve) => replies.push(resolve)))
    const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
    act(() => {
      void refresh()
      void refresh()
    })
    const older = () => replies[0]!({ ok: true, result: balance('11.1100') })
    const newer = () => replies[1]!({ ok: true, result: balance('22.2200') })
    await act(async () => {
      if (order === 'older-first') {
        older()
        newer()
      } else {
        newer()
        older()
      }
    })
    expect(paint()).toContain('22.2200')
    expect(paint()).not.toContain('11.1100')
  }
)

it('retires malformed current Accounts list evidence and recovers on a valid refresh', async () => {
  await mount()
  emit(boundary.streams[0]!, '11.1100')
  const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
  boundary.request.mockResolvedValue({ ok: true, result: {} })
  await act(async () => refresh())
  expect(paint()).not.toContain('11.1100')
  boundary.request.mockResolvedValue({ ok: true, result: balance('22.2200') })
  await act(async () => refresh())
  expect(paint()).toContain('22.2200')
})

it.each([
  { ok: true },
  { ok: true, result: null },
  { ok: true, result: { error: 'refused' } },
  { ok: true, result: { ok: false, error: 'inner refused' } },
  { ok: true, result: { ok: false, error: { message: 'inner refused' } } }
])('preserves Accounts money and presentation for an invalid envelope %j', async (reply) => {
  await mount()
  emit(boundary.streams[0]!, '11.1100')
  const before = paint()
  const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
  boundary.request.mockResolvedValue(reply)
  await act(async () => refresh())
  expect(paint()).toBe(before)
  boundary.request.mockResolvedValue({ ok: true, result: balance('22.2200') })
  await act(async () => refresh())
  expect(paint()).toContain('22.2200')
})

it.each(['response-error', 'rejection'] as const)(
  'preserves current Accounts money after an ordinary %s',
  async (kind) => {
    await mount()
    emit(boundary.streams[0]!, '11.1100')
    const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
    if (kind === 'response-error') {
      boundary.request.mockResolvedValue({
        ok: false,
        error: { code: 'runtime_error', message: 'ordinary failure' }
      })
    } else {
      boundary.request.mockRejectedValue(new Error('ordinary failure'))
    }
    await act(async () => refresh())
    expect(paint()).toContain('11.1100')
    expect(paint()).not.toContain('Invalid accounts snapshot from host')
  }
)

it('does not let a newer missing Accounts result retire an older valid read', async () => {
  await mount()
  emit(boundary.streams[0]!, '11.1100')
  const replies: Array<(reply: unknown) => void> = []
  boundary.request.mockImplementation(() => new Promise((resolve) => replies.push(resolve)))
  const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
  act(() => {
    void refresh()
    void refresh()
  })
  await act(async () => replies[1]!({ ok: true }))
  expect(paint()).toContain('11.1100')
  await act(async () => replies[0]!({ ok: true, result: balance('22.2200') }))
  expect(paint()).toContain('22.2200')
})

it('accepts an account snapshot with unknown envelope-like extension fields', async () => {
  await mount()
  emit(boundary.streams[0]!, '11.1100')
  const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
  const snapshot = balance('22.2200')
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Expected a snapshot fixture object')
  }
  boundary.request.mockResolvedValue({
    ok: true,
    result: { ...snapshot, ok: false, error: 'future host metadata' }
  })
  await act(async () => refresh())
  expect(paint()).toContain('22.2200')
})
