import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostStackNavigationState } from '../navigation/host-stack-navigation'

type NativeResponse = {
  actionIdentifier: string
  notification: {
    date: number
    request: {
      identifier: string
      content: { data: unknown }
      trigger: { type: 'push'; payload?: unknown }
    }
  }
}

const ports = vi.hoisted(() => {
  const storage = new Map<string, string>()
  const secrets = new Map<string, string>()
  const stateListeners = new Set<() => void>()
  const appListeners = new Set<(state: string) => void>()
  const tokenListeners = new Set<unknown>()
  const linkListeners = new Set<unknown>()
  const networkListeners = new Set<unknown>()
  const input: {
    initial: NativeResponse | null
    response: ((response: NativeResponse) => void) | undefined
    state: HostStackNavigationState | undefined
  } = { initial: null, response: undefined, state: undefined }
  const dispatch = vi.fn()
  function subscription<T>(listeners: Set<T>, listener: T) {
    listeners.add(listener)
    return { remove: () => listeners.delete(listener) }
  }
  return {
    storage,
    secrets,
    stateListeners,
    appListeners,
    tokenListeners,
    linkListeners,
    networkListeners,
    subscription,
    input,
    router: { push: vi.fn(), replace: vi.fn() },
    dispatch,
    clear: vi.fn(),
    readSecret: vi.fn(async (key: string): Promise<string | null> => secrets.get(key) ?? null),
    fetch: vi.fn(() => {
      throw new Error('tap must not issue HTTP')
    }),
    socket: vi.fn(() => {
      throw new Error('coarse tap must not open a workspace socket')
    }),
    navigation: {
      addListener: (_event: string, listener: () => void) =>
        subscription(stateListeners, listener).remove,
      dispatch,
      getState: () => input.state
    }
  }
})

vi.mock('react-native', () => ({
  View: 'View',
  Platform: {
    OS: 'ios',
    select: (values: { ios?: unknown; default?: unknown }) => values.ios ?? values.default
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Appearance: {
    getColorScheme: () => 'dark',
    setColorScheme: vi.fn(),
    addChangeListener: () => ({ remove() {} })
  },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) =>
      ports.subscription(ports.appListeners, listener)
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => ports.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      ports.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      ports.storage.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: ports.readSecret,
  setItemAsync: async (key: string, value: string) => {
    ports.secrets.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    ports.secrets.delete(key)
  }
}))
vi.mock('expo-router', () => ({
  Stack: Object.assign(({ children }: { children: ReactNode }) => children, { Screen: () => null }),
  useRouter: () => ports.router,
  useNavigation: () => ports.navigation,
  usePathname: () => '/',
  useGlobalSearchParams: () => ({})
}))
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  setNotificationHandler: vi.fn(),
  getLastNotificationResponse: () => ports.input.initial,
  clearLastNotificationResponse: ports.clear,
  addNotificationResponseReceivedListener: (listener: (response: NativeResponse) => void) => {
    ports.input.response = listener
    return {
      remove: () => {
        ports.input.response = undefined
      }
    }
  },
  addPushTokenListener: (listener: unknown) => ports.subscription(ports.tokenListeners, listener)
}))
vi.mock('expo-task-manager', () => ({ defineTask: vi.fn(), isAvailableAsync: async () => false }))
vi.mock('expo-linking', () => ({
  getInitialURL: async () => null,
  addEventListener: (_event: string, listener: unknown) =>
    ports.subscription(ports.linkListeners, listener)
}))
vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ type: 'WIFI', isConnected: true }),
  addNetworkStateListener: (listener: unknown) =>
    ports.subscription(ports.networkListeners, listener)
}))
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: async () => {},
  hideAsync: async () => {}
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))
vi.mock('expo-localization', () => {
  const locales = [{ languageTag: 'en-US' }]
  return { getLocales: () => locales, useLocales: () => locales }
})
vi.mock('react-native-safe-area-context', async () => {
  const { createContext } = await import('react')
  return {
    SafeAreaProvider: 'SafeAreaProvider',
    SafeAreaFrameContext: createContext(null),
    SafeAreaInsetsContext: createContext(null),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 })
  }
})
vi.mock('expo/fetch', () => ({ fetch: ports.fetch }))

import RootLayout from '../../app/_layout'
import {
  removeHost,
  resetHostStoreForTests,
  updateHostNameAndEndpoint
} from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'

const host = {
  id: 'B',
  name: 'B',
  endpoint: 'ws://b.invalid',
  publicKeyB64: Buffer.alloc(32, 2).toString('base64'),
  lastConnected: 0
}
const sender = deriveHostFingerprint(Buffer.alloc(32, 1).toString('base64'))!
const origin = deriveHostFingerprint(host.publicKeyB64)!
const unknownOrigin = deriveHostFingerprint(Buffer.alloc(32, 3).toString('base64'))!
let tree: ReactTestRenderer | undefined
const appLifetimeListeners = ports.appListeners.size

function response(id: string, fields: Record<string, unknown>, apns = false): NativeResponse {
  const data = { hostFingerprint: sender, origin, ...fields }
  return {
    actionIdentifier: 'default',
    notification: {
      date: 0,
      request: {
        identifier: id,
        // The APNs payload must win over content.data; warm FCM uses flat data.
        content: { data: apns ? { hostId: 'untrusted', worktreeId: 'wrong' } : data },
        trigger: { type: 'push', ...(apns ? { payload: { aps: {}, orca: data } } : {}) }
      }
    }
  }
}
function committedHost() {
  ports.input.state = {
    index: 0,
    routes: [
      {
        name: '__root',
        state: {
          index: 0,
          routes: [
            {
              name: 'h',
              state: {
                key: 'B-stack',
                index: 0,
                routes: [{ key: 'B-index', name: '[hostId]/index', params: { hostId: 'B' } }]
              }
            }
          ]
        }
      }
    ]
  }
  for (const listener of ports.stateListeners) listener()
}
async function mount(initial: NativeResponse | null) {
  ports.input.initial = initial
  await act(async () => {
    tree = create(createElement(RootLayout))
  })
}
async function warm(input: NativeResponse, expected: string) {
  const pushes = ports.router.push.mock.calls.length
  await act(async () => {
    if (!ports.input.response) throw new Error('root response listener absent')
    ports.input.response(input)
    await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledTimes(pushes + 1))
  })
  expect(ports.router.push).toHaveBeenLastCalledWith(expected)
}
async function unmount() {
  await act(async () => {
    tree?.unmount()
    tree = undefined
  })
}
function holdCredential() {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<string | null>()
  ports.readSecret.mockImplementationOnce(async () => {
    entered.resolve()
    return held.promise
  })
  return { entered: entered.promise, ...held }
}

beforeEach(() => {
  vi.clearAllMocks()
  ports.readSecret.mockReset().mockImplementation(async (key) => ports.secrets.get(key) ?? null)
  resetHostStoreForTests()
  ports.storage.clear()
  ports.storage.set('orca:hosts', JSON.stringify([host]))
  ports.storage.set('orca:pushServiceNotificationsEnabled', 'false')
  ports.secrets.clear()
  ports.secrets.set('orca.host-token.B', 'fixture-token-B')
  ports.input.state = undefined
  ports.input.initial = null
  vi.stubGlobal('fetch', ports.fetch)
  vi.stubGlobal('WebSocket', ports.socket)
})
afterEach(async () => {
  try {
    await unmount()
    expect(ports.input.response).toBeUndefined()
    expect(ports.stateListeners.size).toBe(0)
    expect(ports.tokenListeners.size).toBe(0)
    expect(ports.linkListeners.size).toBe(0)
    expect(ports.networkListeners.size).toBe(0)
    expect(ports.appListeners.size).toBe(appLifetimeListeners)
    expect(ports.fetch).not.toHaveBeenCalled()
    expect(ports.socket).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps the current cold/warm coarse destination after a parked stack wakes or an older response settles', async () => {
  await mount(response('cold-B', { hostFingerprint: origin, worktreeId: 'WB' }, true))
  await vi.waitFor(() => expect(ports.stateListeners.size).toBe(1))
  expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/h/B')
  expect(ports.dispatch).not.toHaveBeenCalled()

  await warm(
    response('warm-removed-A', {
      worktreeId: 'WA',
      paneKey: 'paneA',
      executionHost: 'runtime:A'
    }),
    '/h/B'
  )
  expect(ports.stateListeners.size).toBe(0)
  committedHost()
  expect(ports.dispatch).not.toHaveBeenCalled()
  expect(ports.router.replace).not.toHaveBeenCalled()
  expect(ports.router.push.mock.calls).toEqual([['/h/B'], ['/h/B']])

  // Neither retained host: App Home must also retire a pending session owner.
  ports.input.state = undefined
  await warm(response('warm-B', { hostFingerprint: origin, worktreeId: 'WB2' }), '/h/B')
  expect(ports.stateListeners.size).toBe(1)
  await warm(
    response('warm-neither', {
      origin: unknownOrigin,
      worktreeId: 'WA',
      paneKey: 'paneA',
      executionHost: 'runtime:A'
    }),
    '/'
  )
  committedHost()
  expect(ports.stateListeners.size).toBe(0)
  expect(ports.dispatch).not.toHaveBeenCalled()

  // A real metadata commit starts a new catalog generation while an older native read is held.
  resetHostStoreForTests()
  ports.input.state = undefined
  const old = holdCredential()
  try {
    ports.input.response?.(
      response('older-async-B', { hostFingerprint: origin, worktreeId: 'WB3' })
    )
    await old.entered
    await updateHostNameAndEndpoint('B', { endpoint: 'ws://b-new.invalid' })
    await warm(response('newer-removed-A', { worktreeId: 'WA' }), '/h/B')
    const accepted = ports.router.push.mock.calls.length
    const clears = ports.clear.mock.calls.length
    await act(async () => {
      old.resolve('fixture-token-B')
      await old.promise
    })
    committedHost()
    expect(ports.router.push).toHaveBeenCalledTimes(accepted)
    expect(ports.clear).toHaveBeenCalledTimes(clears)
    expect(ports.dispatch).not.toHaveBeenCalled()
    expect(ports.stateListeners.size).toBe(0)
  } finally {
    old.resolve('fixture-token-B')
  }

  // Cold admitted APNs uses the same real path, without the earlier session.
  await unmount()
  ports.router.push.mockClear()
  await mount(
    response(
      'cold-removed-A',
      { worktreeId: 'WA', paneKey: 'paneA', executionHost: 'runtime:A' },
      true
    )
  )
  await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/h/B'))
  expect(ports.dispatch).not.toHaveBeenCalled()
  await unmount()
  ports.router.push.mockClear()
  await mount(
    response(
      'cold-neither',
      {
        origin: unknownOrigin,
        worktreeId: 'WA',
        paneKey: 'paneA',
        executionHost: 'runtime:A'
      },
      true
    )
  )
  await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/'))
  expect(ports.dispatch).not.toHaveBeenCalled()
})

it('rederives membership after the real native catalog await, preserves credential recovery, and ignores late unmounted taps', async () => {
  const pending = holdCredential()
  try {
    await mount(
      response(
        'cold-removal',
        { worktreeId: 'WA', paneKey: 'paneA', executionHost: 'runtime:A' },
        true
      )
    )
    await pending.entered
    await removeHost('B')
    expect(JSON.parse(ports.storage.get('orca:hosts')!)).toEqual([])
    await act(async () => {
      pending.resolve('fixture-token-B')
      await pending.promise
    })
    await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/'))
    committedHost()
    expect(ports.dispatch).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ports.secrets.has('orca.host-token.B')).toBe(false))
  } finally {
    pending.resolve('fixture-token-B')
  }

  await unmount()
  // A current member without a credential is re-paired, while native failure is retry/Home.
  resetHostStoreForTests()
  ports.storage.set('orca:hosts', JSON.stringify([host]))
  ports.secrets.clear()
  await mount(null)
  await warm(response('missing', { worktreeId: 'WA' }), '/pair-scan')
  ports.readSecret.mockRejectedValueOnce(new Error('keychain locked'))
  await warm(response('unavailable', { worktreeId: 'WA' }), '/')
  expect(ports.dispatch).not.toHaveBeenCalled()

  const late = holdCredential()
  try {
    ports.input.response?.(response('late-B', { hostFingerprint: origin, worktreeId: 'WB' }))
    await late.entered
    await unmount()
    const accepted = ports.router.push.mock.calls.length
    const clears = ports.clear.mock.calls.length
    await act(async () => {
      late.resolve('fixture-token-B')
      await late.promise
    })
    committedHost()
    expect(ports.router.push).toHaveBeenCalledTimes(accepted)
    expect(ports.clear).toHaveBeenCalledTimes(clears)
    expect(ports.dispatch).not.toHaveBeenCalled()
  } finally {
    late.resolve('fixture-token-B')
  }
})
