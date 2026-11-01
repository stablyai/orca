// Host-area init omits workspace-scoped keys; on-demand reads/writes must match detail-page storage across this host’s workspaces.
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, string>())
// Hold writes until the test settles them to model the native store queue.
const queued = vi.hoisted((): (() => void)[] => [])

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async (keys: readonly string[]) => keys.map((key) => [key, store.get(key) ?? null]),
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) =>
      new Promise<void>((resolve) =>
        queued.push(() => {
          store.set(key, value)
          resolve()
        })
      ),
    removeItem: (key: string) =>
      new Promise<void>((resolve) =>
        queued.push(() => {
          store.delete(key)
          resolve()
        })
      )
  }
}))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [{ id: 'host-a', name: 'Host', endpoint: 'ws://h', lastConnected: 1 }]
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { usePageHostSnapshot, type PageHostSnapshotView } from './use-page-host-snapshot'
import { createFakeBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import { storageReadParamsSchema, storageReadResultSchema } from './bridge/bridge-native-verbs'
import pageAsyncStorage, { publishPageStorage } from './bridge/page-async-storage'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'
import {
  hydrateMirroredStorage,
  readMirroredKeyOrStore,
  readMirroredStorage,
  writeMirroredStorage
} from '../storage/mirrored-storage-keys'

const CHAT_TABS = 'orca:nativeChatTabs:host-a:wt-1'
const LIVE_INPUT = 'orca:terminalLiveInputDisabled:host-a:wt-1'
const NEVER_STORED = 'orca:nativeChatTabs:host-a:wt-2'
const OTHER_HOST = 'orca:nativeChatTabs:host-b:wt-1'
const FRESH = 'orca:terminalLiveInputDisabled:host-a:wt-2'

function persisted(): void {
  for (const land of queued.splice(0)) {
    land()
  }
}

const mounted: ReactTestRenderer[] = []

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
})

async function snapshotFor(routePathname: string, hostArea: boolean) {
  const held: { view: PageHostSnapshotView | null } = { view: null }
  function Probe() {
    held.view = usePageHostSnapshot('host-a', routePathname, hostArea)
    return null
  }
  await act(async () => {
    mounted.push(create(<Probe />))
  })
  await act(async () => {})
  if (held.view === null) {
    throw new Error('nothing mounted')
  }
  return held.view
}

async function hostAreaPage() {
  const view = await snapshotFor('/h/host-a', true)
  const pair = createFakeBridgePortPair({
    route: { pathname: '/h/host-a' },
    ownsHostArea: true,
    routeGrants: MOBILE_WEB_SHELL_GRANTS,
    storage: view.readStorage().storage,
    onStorageWrite: view.writeStorage,
    serveNativeVerb: async (verb, params) =>
      verb === 'native.storage.read'
        ? { value: await view.readWorkspaceKey(storageReadParamsSchema.parse(params).key) }
        : {}
  })
  await pair.flush()
  const session = pair.client.getShellSession()
  if (session === null) {
    throw new Error('no init')
  }
  publishPageStorage(
    session.storage,
    (key, value) => pair.client.notifyStorageWrite(key, value),
    'host-a',
    '/h/host-a',
    session.storageOversize,
    session.ownsHostArea
      ? async (key) =>
          storageReadResultSchema.parse(
            (await pair.client.callNativeVerb('native.storage.read', { key })).result
          ).value
      : null
  )
  const settled = async <T,>(read: Promise<T>): Promise<T> => {
    await pair.flush()
    return read
  }
  return { view, pair, settled }
}

beforeEach(async () => {
  queued.length = 0
  store.clear()
  store.set(CHAT_TABS, '["tab-1"]')
  store.set(LIVE_INPUT, '["handle-1"]')
  store.set(OTHER_HOST, '["tab-9"]')
  await hydrateMirroredStorage([CHAT_TABS, LIVE_INPUT, NEVER_STORED, FRESH, OTHER_HOST])
})

describe('the per-workspace keys of a host-area page', () => {
  it('keeps unmounted workspace writes readable until native persistence settles', async () => {
    const detail = await snapshotFor('/h/host-a/session/wt-1', false)
    detail.writeStorage(CHAT_TABS, '["pending"]')
    act(() => {
      for (const tree of mounted.splice(0)) {
        tree.unmount()
      }
    })
    expect(store.get(CHAT_TABS)).toBe('["tab-1"]')
    expect(await readMirroredKeyOrStore(CHAT_TABS)).toBe('["pending"]')
    await act(async () => persisted())
    expect(readMirroredStorage([CHAT_TABS])).toEqual({})
    expect(await readMirroredKeyOrStore(CHAT_TABS)).toBe('["pending"]')
  })

  it('reaches init with none of them, and reads each from the shell as a session page would', async () => {
    const perRoute = (await snapshotFor('/h/host-a/session/wt-1', false)).readStorage().storage
    const { view, settled } = await hostAreaPage()
    expect(Object.keys(view.readStorage().storage).filter((key) => key.includes(':host-'))).toEqual(
      []
    )
    for (const key of [CHAT_TABS, LIVE_INPUT]) {
      expect(perRoute[key], key).toBeDefined()
      expect(await settled(pageAsyncStorage.getItem(key)), key).toBe(perRoute[key])
    }
    expect(await settled(pageAsyncStorage.getItem(NEVER_STORED))).toBeNull()
  })

  it("writes both through the bridge to this host's store, a never-stored key included", async () => {
    const { pair, settled } = await hostAreaPage()
    for (const key of [CHAT_TABS, NEVER_STORED, FRESH]) {
      await pageAsyncStorage.setItem(key, '["x"]')
    }
    await pair.flush()
    persisted()
    for (const key of [CHAT_TABS, NEVER_STORED, FRESH]) {
      expect(store.get(key), key).toBe('["x"]')
      expect(await settled(pageAsyncStorage.getItem(key)), key).toBe('["x"]')
    }
  })

  it('reads back its own write before the store has landed it, a removal included', async () => {
    const { settled } = await hostAreaPage()
    await pageAsyncStorage.setItem(NEVER_STORED, '["new"]')
    await pageAsyncStorage.removeItem(CHAT_TABS)
    const read = Promise.all([
      pageAsyncStorage.getItem(NEVER_STORED),
      pageAsyncStorage.getItem(CHAT_TABS)
    ])
    expect(await settled(read)).toEqual(['["new"]', null])
    expect(store.get(CHAT_TABS)).toBe('["tab-1"]')
    persisted()
    expect(store.get(NEVER_STORED)).toBe('["new"]')
    expect(store.has(CHAT_TABS)).toBe(false)
  })

  it('reads a stored key the mirror never held, though another mirrored write lands meanwhile', async () => {
    const relaunched = 'orca:terminalLiveInputDisabled:host-a:alpha'
    store.set(relaunched, '["handle-1"]')
    const view = await snapshotFor('/h/host-a', true)
    const read = view.readWorkspaceKey(relaunched)
    writeMirroredStorage('orca:pins:host-a', '[]')
    expect(await read).toBe('["handle-1"]')
  })

  it('rejects, rather than reading as unset, when the store cannot be read', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('store unavailable'))
    const view = await snapshotFor('/h/host-a', true)
    await expect(view.readWorkspaceKey('orca:nativeChatTabs:host-a:beta')).rejects.toThrow()
  })

  it("refuses another host's key, to read or to write", async () => {
    const { view, pair, settled } = await hostAreaPage()
    await pageAsyncStorage.setItem(OTHER_HOST, '["x"]')
    await pair.flush()
    persisted()
    expect(pair.storageWrites).toEqual([])
    expect(store.get(OTHER_HOST)).toBe('["tab-9"]')
    await expect(view.readWorkspaceKey(OTHER_HOST)).rejects.toThrow()
    // Unreadable keys must reject rather than appear unset and invite destructive replacement.
    const asked = pair.client.callNativeVerb('native.storage.read', { key: OTHER_HOST })
    await pair.flush()
    await expect(asked).rejects.toThrow()
    expect(await settled(pageAsyncStorage.getItem(OTHER_HOST))).toBeNull()
  })

  it('reads and writes none of them for a page that does not own the host area', async () => {
    const phoneList = await snapshotFor('/h/host-a', false)
    await expect(phoneList.readWorkspaceKey(CHAT_TABS)).rejects.toThrow()
    phoneList.writeStorage(CHAT_TABS, '["no"]')
    persisted()
    expect(store.get(CHAT_TABS)).toBe('["tab-1"]')
    const pair = createFakeBridgePortPair({ route: { pathname: '/h/host-a' } })
    await pair.flush()
    pair.client.notifyStorageWrite(CHAT_TABS, '["x"]')
    await pair.flush()
    expect(pair.storageWrites).toEqual([])
  })
})
