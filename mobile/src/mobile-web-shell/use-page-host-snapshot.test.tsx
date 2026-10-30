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
vi.mock('../transport/host-store', () => ({
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

import { savePinnedIds } from '../storage/preferences'
import { writeLastVisitedWorktree } from '../worktree/last-visited-worktree-by-host'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from './page-storage-keys'
import { usePageHostSnapshot, type PageHostSnapshotView } from './use-page-host-snapshot'
import { persistMirrored, readMirroredStorage } from '../storage/mirrored-storage-keys'

const PINS = 'orca:pins:host-1'
const LAST_VISITED = 'orca:last-visited-worktree'
const CHAT_TABS = 'orca:nativeChatTabs:host-1:wt-1'
const JOURNAL = 'orca:mobileStructuredSendOperations:v1'
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

it.each([10, 100])('releases payloads from %i historical workspace snapshots', async (count) => {
  const keys: string[] = []
  for (let index = 0; index < count; index++) {
    const workspace = `folder:historical-${index}`
    const key = `orca:terminalDrafts:host-1:${encodeURIComponent(workspace)}`
    const value = `${index}:${'x'.repeat(8 * 1024)}`
    keys.push(key)
    doubles.store.set(key, value)
    const mounted = await mount(`/h/host-1/session/${encodeURIComponent(workspace)}`)
    expect(mounted.view().readStorage().storage[key]).toBe(value)
    await mounted.unmount()
  }
  expect(Object.keys(readMirroredStorage(keys))).toHaveLength(0)
  expect(keys.every((key) => doubles.store.has(key))).toBe(true)
  const reopened = await mount('/h/host-1/session/folder%3Ahistorical-0')
  expect(reopened.view().readStorage().storage[keys[0]!]).toBe(doubles.store.get(keys[0]!))
})

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
  it('carries the write the page just made, not the map it was primed with', async () => {
    doubles.store.set(PINS, '["one"]')
    const mounted = await mount()
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["one"]' })
    // Reloading the document in the same mount must receive its latest write in init.
    await act(async () => {
      mounted.view().writeStorage(PINS, '["one","two"]')
    })
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["one","two"]' })
    expect(doubles.writes).toEqual([{ key: PINS, value: '["one","two"]' }])
  })

  it('drops a key the page removed', async () => {
    doubles.store.set(PINS, '["one"]')
    const mounted = await mount()
    await act(async () => {
      mounted.view().writeStorage(PINS, null)
    })
    expect(mounted.view().readStorage().storage).toEqual({})
  })

  it('carries what the app wrote from its own screens on the next init, not the one after', async () => {
    const mounted = await mount()
    expect(mounted.view().readStorage().storage).toEqual({})
    // Native writers must update the mirror before reload; no store reread occurs before this init.
    await writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'host-1/repo/wt' })
    await savePinnedIds('host-1', new Set(['one']))
    expect(mounted.view().readStorage().storage).toEqual({
      [LAST_VISITED]: JSON.stringify({
        hostId: 'host-1',
        worktreeId: 'host-1/repo/wt',
        byHost: { 'host-1': { worktreeId: 'host-1/repo/wt' } }
      }),
      [PINS]: '["one"]'
    })
  })

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

  it('picks up what the app changed underneath, on the next ask', async () => {
    const mounted = await mount()
    expect(mounted.view().readStorage().storage).toEqual({})
    doubles.store.set(PINS, '["set-by-the-app"]')
    await act(async () => {
      mounted.view().refreshStorage()
    })
    expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["set-by-the-app"]' })
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

  it('hands a route that names no workspace neither of the two, so the line above is the route', async () => {
    doubles.store.set(CHAT_TABS, '{"tab-1":"chat"}')
    const mounted = await mount('/h/host-1')
    await act(async () => {
      mounted.view().refreshStorage()
    })
    expect(mounted.view().readStorage().storage).toEqual({})
  })

  it('leaves out a value the page would refuse the whole frame over, and says which', async () => {
    // A real 48-send journal exceeds the value cap; sending it whole would reject all of init.
    const warned: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => warned.push(args)
    try {
      doubles.store.set(PINS, '["one"]')
      doubles.store.set(JOURNAL, 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1))
      const mounted = await mount()
      await act(async () => {
        mounted.view().refreshStorage()
      })
      expect(mounted.view().readStorage().storage).toEqual({ [PINS]: '["one"]' })
    } finally {
      console.warn = warn
    }
    expect(JSON.stringify(warned)).toContain(JOURNAL)
  })

  it('carries the same journal at exactly the bound, so the drop above discriminates', async () => {
    const atBound = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS)
    doubles.store.set(JOURNAL, atBound)
    const mounted = await mount()
    await act(async () => {
      mounted.view().refreshStorage()
    })
    expect(mounted.view().readStorage().storage).toEqual({ [JOURNAL]: atBound })
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

  it("carries the stored name identity, so the page can tell the phone's override from the desktop's name", async () => {
    doubles.hostIdentity = {
      personalName: 'Host One',
      lastKnownMachineName: 'm4airs-Air',
      lastKnownHostPlatform: 'darwin'
    }
    const mounted = await mount()
    expect(mounted.view().snapshot?.host).toEqual({
      id: 'host-1',
      name: 'Host One',
      personalName: 'Host One',
      lastKnownMachineName: 'm4airs-Air',
      lastKnownHostPlatform: 'darwin',
      endpoint: 'ws://host-1',
      lastConnected: 3
    })
  })
})

describe('a host the app store would not answer for', () => {
  it('says so rather than leaving the caller holding a session with no host', async () => {
    doubles.hostsReject = true
    const mounted = await mount()
    expect(mounted.view().snapshot).toBeNull()
    expect(mounted.view().unreadable).toBe(true)
  })

  it('reports a readable host without an unreadable-store failure', async () => {
    const mounted = await mount()
    expect(mounted.view().snapshot?.host.id).toBe('host-1')
    expect(mounted.view().unreadable).toBe(false)
  })
})
