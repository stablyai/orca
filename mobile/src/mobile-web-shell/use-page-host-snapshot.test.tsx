import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Doubles = {
  store: Map<string, string>
  writes: { key: string; value: string | null }[]
  hostsReject: boolean
  hostIdentity: Record<string, string>
  holdReads: boolean
  releaseReads: (() => void)[]
  rejectReads: boolean
}

const doubles = vi.hoisted((): Doubles => ({
  store: new Map(),
  writes: [],
  hostsReject: false,
  hostIdentity: {},
  holdReads: false,
  releaseReads: [],
  rejectReads: false
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async (keys: readonly string[]) => {
      if (doubles.rejectReads) {
        throw new Error('storage unavailable')
      }
      // Snapshot at read start, then defer completion so intervening writes can make the answer stale.
      const answer = keys.map((key) => [key, doubles.store.get(key) ?? null])
      if (doubles.holdReads) {
        await new Promise<void>((resolve) => doubles.releaseReads.push(resolve))
      }
      return answer
    },
    setItem: async (key: string, value: string) => {
      doubles.writes.push({ key, value })
      doubles.store.set(key, value)
    },
    removeItem: async (key: string) => {
      doubles.writes.push({ key, value: null })
      doubles.store.delete(key)
    },
    getItem: async (key: string) => doubles.store.get(key) ?? null
  }
}))
vi.mock('../host-catalog/host-store', () => ({
  loadHosts: async () => {
    if (doubles.hostsReject) {
      throw new Error('the keychain would not answer')
    }
    return [
      {
        id: 'host-1',
        name: 'Host One',
        ...doubles.hostIdentity,
        endpoint: 'ws://host-1',
        lastConnected: 3
      }
    ]
  }
}))

import '../storage/preferences'
import '../worktree/last-visited-worktree-by-host'
import { usePageHostSnapshot, type PageHostSnapshotView } from './use-page-host-snapshot'
import { persistMirrored, readMirroredStorage } from '../storage/mirrored-storage-keys'

const PINS = 'orca:pins:host-1'

const CHAT_TABS = 'orca:nativeChatTabs:host-1:wt-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'

const mountedTrees: ReturnType<typeof create>[] = []

function createTracked(element: Parameters<typeof create>[0]): ReturnType<typeof create> {
  const tree = create(element)
  mountedTrees.push(tree)
  return tree
}

afterEach(async () => {
  await act(async () => {
    for (const tree of mountedTrees.splice(0)) {
      tree.unmount()
    }
  })
})

async function mount(routePathname = SESSION_ROUTE): Promise<{
  view: () => PageHostSnapshotView
  unmount: () => Promise<void>
}> {
  const held: { view: PageHostSnapshotView | null } = { view: null }
  let tree: ReturnType<typeof create> | undefined
  function Probe(): null {
    held.view = usePageHostSnapshot('host-1', routePathname)
    return null
  }
  await act(async () => {
    tree = createTracked(createElement(Probe))
  })
  return {
    view: () => {
      if (held.view === null) {
        throw new Error('the hook did not mount')
      }
      return held.view
    },
    unmount: async () => {
      await act(async () => tree?.unmount())
    }
  }
}

beforeEach(() => {
  doubles.store.clear()
  doubles.writes.length = 0
  doubles.hostsReject = false
  doubles.hostIdentity = {}
  doubles.holdReads = false
  doubles.releaseReads.length = 0
  doubles.rejectReads = false
})

function releaseReads(): void {
  for (const release of doubles.releaseReads.splice(0)) {
    release()
  }
}

it('retains shared snapshot keys until their last mounted owner leaves', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"chat"}')
  const first = await mount()
  const second = await mount()
  await first.unmount()
  expect(second.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"chat"}')
  await second.unmount()
  expect(readMirroredStorage([CHAT_TABS])).toEqual({})
})

it('keeps the last active fallback through hydration failure and releases it on unmount', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"chat"}')
  const mounted = await mount()
  doubles.rejectReads = true
  await act(async () => mounted.view().refreshStorage())
  expect(mounted.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"chat"}')
  await mounted.unmount()
  expect(readMirroredStorage([CHAT_TABS])).toEqual({})
})

it('does not repopulate a retired route when its hydration completes late', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"chat"}')
  doubles.holdReads = true
  const mounted = await mount()
  await mounted.unmount()
  await act(async () => releaseReads())
  expect(readMirroredStorage([CHAT_TABS])).toEqual({})
})

it('does not let old hydration overwrite a freshly reopened route', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"old"}')
  doubles.holdReads = true
  const previous = await mount()
  await previous.unmount()
  doubles.store.set(CHAT_TABS, '{"tab":"new"}')
  doubles.holdReads = false
  const reopened = await mount()
  expect(reopened.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"new"}')
  await act(async () => releaseReads())
  expect(reopened.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"new"}')
})

it('waits for retry when an evicted route cannot reload its durable preferences', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"chat"}')
  const previous = await mount()
  await previous.unmount()
  doubles.rejectReads = true
  const reopened = await mount()
  expect(reopened.view().snapshot).toBeNull()
  expect(reopened.view().unreadable).toBe(true)
  doubles.rejectReads = false
  await act(async () => reopened.view().retry())
  expect(reopened.view().snapshot?.host.id).toBe('host-1')
  expect(reopened.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"chat"}')
})

it('becomes ready when an unrelated key is written during a cold route hydration', async () => {
  doubles.store.set(CHAT_TABS, '{"tab":"chat"}')
  doubles.holdReads = true
  const mounted = await mount()
  await act(async () => {
    await persistMirrored('orca:unrelated-preference', 'x')
    releaseReads()
  })
  expect(mounted.view().unreadable).toBe(false)
  expect(mounted.view().snapshot?.host.id).toBe('host-1')
  expect(mounted.view().readStorage().storage[CHAT_TABS]).toBe('{"tab":"chat"}')
})

it('keeps host-wide keys mirrored while the next route hydrates', async () => {
  doubles.store.set(PINS, '["one"]')
  const held: { view: PageHostSnapshotView | null } = { view: null }
  function Probe({ route }: { route: string }): null {
    held.view = usePageHostSnapshot('host-1', route)
    return null
  }
  let tree: ReturnType<typeof create> | undefined
  await act(async () => {
    tree = createTracked(createElement(Probe, { route: SESSION_ROUTE }))
  })
  doubles.holdReads = true
  await act(async () => {
    tree?.update(createElement(Probe, { route: '/h/host-1/session/wt-2' }))
  })
  expect(readMirroredStorage([PINS])).toEqual({ [PINS]: '["one"]' })
  await act(async () => releaseReads())
  expect(held.view?.snapshot?.host.id).toBe('host-1')
})

describe('what the shell puts on every init', () => {
  it('keeps a write that landed while the store read was still open', async () => {
    doubles.store.set(PINS, '["stored"]')
    const mounted = await mount()
    doubles.holdReads = true
    await act(async () => {
      const seated = mounted.view().refreshStorage()
      mounted.view().writeStorage(PINS, '["just-written"]')
      releaseReads()
      await seated
    })
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["just-written"]' })
  })

  it('never carries another host key, whatever the store holds', async () => {
    doubles.store.set(PINS, '["mine"]')
    doubles.store.set('orca:pins:host-2', '["theirs"]')
    const mounted = await mount()
    await act(async () => {
      mounted.view().refreshStorage()
    })
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["mine"]' })
    await act(async () => {
      mounted.view().writeStorage('orca:pins:host-2', '["overwritten"]')
    })
    expect(doubles.writes).toEqual([])
    expect(doubles.store.get('orca:pins:host-2')).toBe('["theirs"]')
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["mine"]' })
  })

  it("carries the session route's own workspace, and never the workspace beside it", async () => {
    doubles.store.set(CHAT_TABS, '{"tab-1":"chat"}')
    doubles.store.set('orca:nativeChatTabs:host-1:wt-2', '{"tab-9":"chat"}')
    const mounted = await mount()
    await act(async () => {
      mounted.view().refreshStorage()
    })
    expect(mounted.view().readStorage().storage).toEqual({ [CHAT_TABS]: '{"tab-1":"chat"}' })
    await act(async () => {
      mounted.view().writeStorage('orca:nativeChatTabs:host-1:wt-2', '{}')
    })
    expect(doubles.writes).toEqual([])
    expect(doubles.store.get('orca:nativeChatTabs:host-1:wt-2')).toBe('{"tab-9":"chat"}')
    expect(mounted.view().readStorage().storage).toEqual({ [CHAT_TABS]: '{"tab-1":"chat"}' })
  })
})

describe('the host the page is handed', () => {
  it('is not built until the store has answered as well as the keychain', async () => {
    // Resolve profile before storage to prove host construction waits for both instead of priming unpinned state.
    doubles.store.set(PINS, '["one"]')
    doubles.holdReads = true
    const mounted = await mount()
    expect(mounted.view().snapshot).toBeNull()
    await act(async () => {
      releaseReads()
    })
    expect(mounted.view().snapshot?.host.id).toBe('host-1')
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["one"]' })
  })
})
