import { createElement } from 'react'
import { Text, ScrollView } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

it.each(['response-error', 'rejection', 'malformed-success'] as const)(
  'ignores a retired Accounts %s after newer ready evidence',
  async (kind) => {
    await mount()
    emit(boundary.streams[0]!, '11.1100')
    let resolve: (reply: unknown) => void = () => {}
    let reject: (error: Error) => void = () => {}
    boundary.request.mockReturnValue(
      new Promise((done, fail) => {
        resolve = done
        reject = fail
      })
    )
    const refresh = renderer?.root.findByType(ScrollView).props.refreshControl.props.onRefresh
    act(() => {
      void refresh()
    })
    act(() =>
      boundary.streams[0]!({
        type: 'ready',
        snapshot: kind === 'malformed-success' ? balance('22.2200') : {}
      })
    )
    await act(async () => {
      if (kind === 'rejection') {
        reject(new Error('retired request failure'))
      } else if (kind === 'response-error') {
        resolve({ ok: false, error: { code: 'runtime_error', message: 'retired request failure' } })
      } else {
        resolve({ ok: true, result: {} })
      }
    })
    if (kind === 'malformed-success') {
      expect(paint()).toContain('22.2200')
    } else {
      expect(paint()).toContain('Invalid accounts snapshot from host')
    }
    expect(paint()).not.toContain('retired request failure')
    expect(paint()).not.toContain('11.1100')
  }
)
