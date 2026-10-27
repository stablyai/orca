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
}

const doubles = vi.hoisted((): Doubles => ({
  store: new Map(),
  writes: [],
  hostsReject: false,
  hostIdentity: {},
  holdReads: false,
  releaseReads: []
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async (keys: readonly string[]) => {
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

async function mount(routePathname = SESSION_ROUTE): Promise<{ view: () => PageHostSnapshotView }> {
  const held: { view: PageHostSnapshotView | null } = { view: null }
  function Probe(): null {
    held.view = usePageHostSnapshot('host-1', routePathname)
    return null
  }
  await act(async () => {
    createTracked(createElement(Probe))
  })
  return {
    view: () => {
      if (held.view === null) {
        throw new Error('the hook did not mount')
      }
      return held.view
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
})

function releaseReads(): void {
  for (const release of doubles.releaseReads.splice(0)) {
    release()
  }
}

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
