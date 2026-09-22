import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Doubles = {
  store: Map<string, string>
  writes: { key: string; value: string | null }[]
  hostsReject: boolean
  /** Holds every store read open, which is how the two reads are made to answer out of order. */
  holdReads: boolean
  releaseReads: (() => void)[]
}

const doubles = vi.hoisted((): Doubles => ({
  store: new Map(),
  writes: [],
  hostsReject: false,
  holdReads: false,
  releaseReads: []
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async (keys: readonly string[]) => {
      // Read first, held after: a store answers with what it held when it was asked, which is what
      // makes a write that lands while the read is open something the answer cannot know about.
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
    // Read back by the mirror after every write it makes, which is how the note follows what the
    // store took rather than what it was handed (ruling 35).
    getItem: async (key: string) => doubles.store.get(key) ?? null
  }
}))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => {
    if (doubles.hostsReject) {
      throw new Error('the keychain would not answer')
    }
    return [{ id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }]
  }
}))

import { savePinnedIds } from '../storage/preferences'
import { writeLastVisitedWorktree } from '../worktree/last-visited-worktree-repo'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from './page-storage-keys'
import { usePageHostSnapshot, type PageHostSnapshotView } from './use-page-host-snapshot'

const PINS = 'orca:pins:host-1'
const LAST_VISITED = 'orca:last-visited-worktree'
const CHAT_TABS = 'orca:nativeChatTabs:host-1:wt-1'
const JOURNAL = 'orca:mobileStructuredSendOperations:v1'
/** The route every case below mounts for: the one page route with workspace-scoped keys. */
const SESSION_ROUTE = '/h/host-1/session/wt-1'

async function mount(routePathname = SESSION_ROUTE): Promise<{ view: () => PageHostSnapshotView }> {
  const held: { view: PageHostSnapshotView | null } = { view: null }
  function Probe(): null {
    held.view = usePageHostSnapshot('host-1', routePathname)
    return null
  }
  await act(async () => {
    create(createElement(Probe))
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
    // The device repro: the page writes, its document reloads inside this same mount, and the
    // `init` that primes the new document has to carry the write rather than what came before it.
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
    // The device repro: the session screen writes while the page is open, the document reloads,
    // and the `init` answering its ready is built from this map with no read in between. A mirror
    // only the store read refreshed would hand the drawer the repo the user left, an `init` late.
    writeLastVisitedWorktree({ hostId: 'host-1', worktreeId: 'host-1/repo/wt' })
    await savePinnedIds('host-1', new Set(['one']))
    expect(mounted.view().readStorage().storage).toEqual({
      [LAST_VISITED]: JSON.stringify({ hostId: 'host-1', worktreeId: 'host-1/repo/wt' }),
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
    // The read was already behind the write when it answered, so putting it back would undo a pin
    // the page has been told is set.
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
    // And a write for one is refused rather than mirrored, so a later read cannot answer with it.
    await act(async () => {
      mounted.view().writeStorage('orca:pins:host-2', '["theirs"]')
    })
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
    // The send journal is the real one: 48 unsettled sends put it past the cap, and `init` is
    // refined on that bound — so handing it over takes the session screen down rather than one key.
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
    // Two unordered reads: the host is built from the snapshot and answers the page's pending
    // `ready` at once, so a profile that beat the store would prime the page from an empty map and
    // the list would paint unpinned until the catalog reply reconciled it.
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

describe('a host the app store would not answer for', () => {
  it('says so rather than leaving the caller holding a session with no host', async () => {
    doubles.hostsReject = true
    const mounted = await mount()
    expect(mounted.view().snapshot).toBeNull()
    expect(mounted.view().unreadable).toBe(true)
  })

  it('is not the same as a host that is simply not there', async () => {
    const mounted = await mount()
    expect(mounted.view().snapshot?.host.id).toBe('host-1')
    expect(mounted.view().unreadable).toBe(false)
  })
})
