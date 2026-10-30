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
  const keyboardListeners = new Set<unknown>()
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
    keyboardListeners,
    subscription,
    input,
    router: { push: vi.fn(), replace: vi.fn() },
    dispatch,
    clear: vi.fn(),
    readHosts: vi.fn<(raw: string | null) => void>(),
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
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  Keyboard: {
    addListener: (_event: string, listener: unknown) =>
      ports.subscription(ports.keyboardListeners, listener)
  },
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
    getItem: async (key: string) => {
      const raw = ports.storage.get(key) ?? null
      if (key === 'orca:hosts') ports.readHosts(raw)
      return raw
    },
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
import * as hostStore from '../transport/host-store'
import * as metadataStore from '../transport/host-metadata-store'
import type { HostCatalogEntry, StoredHostProfile } from '../transport/types'
import { deriveHostFingerprint } from './push-host-fingerprint'

const { removeHost, resetHostStoreForTests, updateHostNameAndEndpoint } = hostStore

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
    // Main's keyboard observation lives for the JS process, including root recovery.
    expect(ports.keyboardListeners.size).toBe(3)
    expect(ports.fetch).not.toHaveBeenCalled()
    expect(ports.socket).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps the current cold/warm coarse destination after a parked stack wakes or an older response settles', async () => {
  // Only this first root owns the process's initial native response.
  await mount(
    response(
      'cold-removed-A',
      { worktreeId: 'WA', paneKey: 'paneA', executionHost: 'runtime:A' },
      true
    )
  )
  await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/h/B'))
  expect(ports.stateListeners.size).toBe(0)
  expect(ports.dispatch).not.toHaveBeenCalled()

  await warm(response('warm-B-parked', { hostFingerprint: origin, worktreeId: 'WB' }), '/h/B')
  expect(ports.stateListeners.size).toBe(1)
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
  expect(ports.router.push.mock.calls).toEqual([['/h/B'], ['/h/B'], ['/h/B']])

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

  // Recovery in the same process ignores initial native input; new taps use its warm listener.
  await unmount()
  ports.router.push.mockClear()
  await mount(
    response('recovery-initial-B', { hostFingerprint: origin, worktreeId: 'WB-recovery' }, true)
  )
  expect(ports.router.push).not.toHaveBeenCalled()
  await warm(
    response(
      'recovery-removed-A',
      { worktreeId: 'WA', paneKey: 'paneA', executionHost: 'runtime:A' },
      true
    ),
    '/h/B'
  )
  expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/h/B')
  expect(ports.dispatch).not.toHaveBeenCalled()
  await unmount()
  ports.router.push.mockClear()
  await mount(null)
  await warm(
    response(
      'recovery-neither',
      {
        origin: unknownOrigin,
        worktreeId: 'WA',
        paneKey: 'paneA',
        executionHost: 'runtime:A'
      },
      true
    ),
    '/'
  )
  expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/')
  expect(ports.dispatch).not.toHaveBeenCalled()
})

it('rederives membership after the real native catalog await, preserves credential recovery, and ignores late unmounted taps', async () => {
  const pending = holdCredential()
  try {
    await mount(null)
    if (!ports.input.response) throw new Error('root response listener absent')
    ports.input.response(
      response(
        'warm-removal',
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

it.each([10, 100])('bounds actual warm tap membership work for %i hosts', async (n) => {
  // Settle inherited UI/root setup before measuring the actual notification trigger.
  await mount(null)
  expect(ports.readHosts).not.toHaveBeenCalled()
  expect(ports.readSecret).not.toHaveBeenCalled()
  const profiles = [
    ...Array.from({ length: n - 1 }, (_, i) => ({
      ...host,
      id: `host-${String(i).padStart(3, '0')}`,
      publicKeyB64: Buffer.alloc(32, i + 4).toString('base64')
    })),
    host
  ]
  const raw = JSON.stringify(profiles)
  const removed = JSON.stringify(profiles.slice(0, -1))
  const readBytes = () =>
    ports.readHosts.mock.calls.map(([value]) => Buffer.byteLength(value ?? ''))
  ports.storage.set('orca:hosts', raw)
  for (const profile of profiles) ports.secrets.set(`orca.host-token.${profile.id}`, 'token')
  let joined = false
  let currentReads = 0,
    records = 0,
    entries = 0,
    filters = 0,
    kept = 0
  const loadCatalog = hostStore.loadHostCatalog
  const loadMetadata = metadataStore.loadStoredHostProfiles
  const catalogSpy = vi.spyOn(hostStore, 'loadHostCatalog').mockImplementation(async () => {
    joined = false
    const catalog = await loadCatalog()
    joined = true
    return new Proxy(catalog, {
      get(target, key, receiver) {
        if (key !== 'filter') return Reflect.get(target, key, receiver)
        return (
          predicate: (row: HostCatalogEntry, index: number, rows: HostCatalogEntry[]) => unknown,
          thisArg?: unknown
        ) =>
          target.filter((row, index, rows) => {
            filters++
            const accepted = predicate.call(thisArg, row, index, rows)
            if (accepted) kept++
            return accepted
          })
      }
    })
  })
  const metadataSpy = vi
    .spyOn(metadataStore, 'loadStoredHostProfiles')
    .mockImplementation(async () => {
      const current = await loadMetadata()
      if (!joined || !current) return current
      currentReads++
      return new Proxy(current, {
        get(target, key, receiver) {
          if (key !== 'map') return Reflect.get(target, key, receiver)
          return <U,>(
            callback: (row: StoredHostProfile, index: number, rows: StoredHostProfile[]) => U,
            thisArg?: unknown
          ) => {
            const mapped = target.map((row, index, rows) => {
              records++
              return callback.call(thisArg, row, index, rows)
            })
            const values = mapped.values.bind(mapped)
            mapped[Symbol.iterator] = function* () {
              for (const entry of values()) {
                entries++
                yield entry
              }
              return undefined
            }
            return mapped
          }
        }
      })
    })
  let pending: ReturnType<typeof holdCredential> | undefined
  try {
    await warm(
      response(
        `scaled-${n}-retained`,
        { worktreeId: 'WA', paneKey: 'paneA', executionHost: 'runtime:A' },
        true
      ),
      '/h/B'
    )
    await vi.waitFor(() => expect(ports.router.push).toHaveBeenCalledExactlyOnceWith('/h/B'))
    expect({ currentReads, records, entries, filters, kept }).toEqual({
      currentReads: 1,
      records: n,
      entries: n,
      filters: n,
      kept: n
    })
    expect(ports.readSecret).toHaveBeenCalledTimes(n)
    expect(readBytes()).toEqual([Buffer.byteLength(raw), Buffer.byteLength(raw)])
    expect(readBytes().reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(512 * n)

    resetHostStoreForTests()
    ports.readHosts.mockClear()
    ports.readSecret.mockClear()
    currentReads = records = entries = filters = kept = 0
    pending = holdCredential()
    if (!ports.input.response) throw new Error('root response listener absent')
    ports.input.response(
      response(`scaled-${n}-removed`, {
        worktreeId: 'WA',
        paneKey: 'paneA',
        executionHost: 'runtime:A'
      })
    )
    await pending.entered
    // The upstream catalog retains B's valid credential; the next authoritative snapshot does not.
    ports.storage.set('orca:hosts', removed)
    pending.resolve('token')
    await vi.waitFor(() => expect(ports.router.push.mock.calls).toEqual([['/h/B'], ['/']]))
    expect({ currentReads, records, entries, filters, kept }).toEqual({
      currentReads: 1,
      records: n - 1,
      entries: n - 1,
      filters: n,
      kept: n - 1
    })
    expect(records + entries + filters).toBeLessThanOrEqual(3 * n)
    expect(ports.readSecret).toHaveBeenCalledTimes(n)
    expect(readBytes()).toEqual([Buffer.byteLength(raw), Buffer.byteLength(removed)])
    expect(readBytes().reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(512 * n)
    committedHost()
    expect(ports.dispatch).not.toHaveBeenCalled()
    expect(ports.router.replace).not.toHaveBeenCalled()
    expect(ports.stateListeners.size).toBe(0)
  } finally {
    pending?.resolve('token')
    try {
      await unmount()
    } finally {
      metadataSpy.mockRestore()
      catalogSpy.mockRestore()
    }
  }
})
