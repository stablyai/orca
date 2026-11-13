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
vi.mock('../host-catalog/host-store', () => ({
  loadHosts: async () => [{ id: 'host-a', name: 'Host', endpoint: 'ws://h', lastConnected: 1 }]
}))

import { usePageHostSnapshot, type PageHostSnapshotView } from './use-page-host-snapshot'
import './bridge/bridge-port-pair-test-harness'
import './bridge/bridge-native-verbs'
import './bridge/page-async-storage'
import './page-route-policy'
import { readMirroredKeyOrStore, readMirroredStorage } from '../storage/mirrored-storage-keys'

const CHAT_TABS = 'orca:nativeChatTabs:host-a:wt-1'

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

beforeEach(() => {
  queued.length = 0
  store.clear()
  store.set(CHAT_TABS, '["tab-1"]')
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
})
