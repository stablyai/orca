import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'

const OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS = 10_000

const createOffscreenBrowserWindow = vi.fn<(partition: string) => unknown>()
const loadOffscreenBrowserUrl = vi.fn<
  (win: unknown, url: string, timeoutMs?: number) => Promise<void>
>(async () => {})

vi.mock('./offscreen-browser-window', () => ({
  createOffscreenBrowserWindow: (partition: string) => createOffscreenBrowserWindow(partition),
  loadOffscreenBrowserUrl: (win: unknown, url: string, timeoutMs?: number) =>
    loadOffscreenBrowserUrl(win, url, timeoutMs),
  OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS: 10_000
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: (id: string) => ({ id, partition: `persist:${id}`, label: id }),
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:default', label: 'Default' })
  }
}))

const { OffscreenBrowserBackend } = await import('./offscreen-browser-backend')

type FakeWindow = BrowserWindow & {
  __id: number
  __destroyed: boolean
  __url: string
  __destroyedListeners: (() => void)[]
  __navigationListeners: ((e: unknown, url: string, isMainFrame?: boolean) => void)[]
  navigateTo: (url: string, isMainFrame?: boolean) => void
  __loading: boolean
}

let nextWebContentsId = 100

function makeWindow(): FakeWindow {
  const id = nextWebContentsId++
  const win = {
    __id: id,
    __destroyed: false,
    __url: 'about:blank',
    __destroyedListeners: [] as (() => void)[],
    __navigationListeners: [] as ((e: unknown, url: string, isMainFrame?: boolean) => void)[],
    __loading: false,
    isDestroyed: () => win.__destroyed,
    navigateTo: (url: string, isMainFrame = true) => {
      if (isMainFrame) {
        win.__url = url
      }
      for (const listener of win.__navigationListeners) {
        listener(null, url, isMainFrame)
      }
    },
    destroy: () => {
      win.__destroyed = true
      for (const listener of win.__destroyedListeners) {
        listener()
      }
    },
    webContents: {
      id,
      isDestroyed: () => win.__destroyed,
      getURL: () => win.__url,
      isLoading: () => win.__loading,
      getTitle: () => `title-${id}`,
      once: (event: string, listener: () => void) => {
        if (event === 'destroyed') {
          win.__destroyedListeners.push(listener)
        }
      },
      on: (event: string, listener: (e: unknown, url: string, isMainFrame?: boolean) => void) => {
        if (event === 'did-navigate') {
          win.__navigationListeners.push((e, url, isMainFrame) => {
            if (isMainFrame !== false) {
              listener(e, url)
            }
          })
        }
        if (event === 'did-navigate-in-page') {
          win.__navigationListeners.push(listener)
        }
      }
    }
  } as unknown as FakeWindow
  return win
}

type Harness = {
  backend: InstanceType<typeof OffscreenBrowserBackend>
  manager: BrowserManager
  bridge: AgentBrowserBridge
  order: string[]
  registered: Map<string, number>
  windows: FakeWindow[]
  clock: { value: number }
  activePageId: string | undefined
  pagesChanged: (string | undefined)[]
  certificateFailurePageIds: Set<string>
  downloadingPageIds: Set<string>
}

function createHarness(
  overrides: {
    pinned?: Set<string>
    activePageId?: string
    loadError?: { code: number; description: string; validatedUrl: string } | null
    certificateFailurePageIds?: string[]
    downloadingPageIds?: string[]
  } = {}
): Harness {
  const state = {
    activePageId: overrides.activePageId,
    certificateFailurePageIds: new Set<string>(overrides.certificateFailurePageIds ?? []),
    downloadingPageIds: new Set<string>(overrides.downloadingPageIds ?? []),
    pagesChanged: [] as (string | undefined)[]
  }
  const order: string[] = []
  const registered = new Map<string, number>()
  const windows: FakeWindow[] = []
  const clock = { value: 1_000_000 }

  createOffscreenBrowserWindow.mockImplementation(() => {
    const win = makeWindow()
    windows.push(win)
    return win
  })

  const manager = {
    registerOffscreenGuest: ({
      browserPageId,
      webContentsId
    }: {
      browserPageId: string
      webContentsId: number
    }) => {
      order.push(`register:${browserPageId}:${webContentsId}`)
      registered.set(browserPageId, webContentsId)
    },
    unregisterGuest: (browserPageId: string) => {
      order.push(`unregister:${browserPageId}`)
      registered.delete(browserPageId)
    },
    getGuestWebContentsId: (browserPageId: string) => registered.get(browserPageId) ?? null,
    getBrowserPageLoadError: () => overrides.loadError ?? null,
    getBrowserPageCertificateFailure: (browserPageId: string) =>
      state.certificateFailurePageIds.has(browserPageId) ? { challengeId: 'c' } : null,
    hasActiveBrowserPageDownload: (browserPageId: string) =>
      state.downloadingPageIds.has(browserPageId)
  } as unknown as BrowserManager

  const bridge = {
    onTabClosed: vi.fn(async (webContentsId: number) => {
      order.push(`session-destroy:${webContentsId}`)
    }),
    onProcessSwap: vi.fn(async (browserPageId: string, webContentsId: number) => {
      order.push(`process-swap:${browserPageId}:${webContentsId}`)
    }),
    isActiveBrowserPage: (browserPageId: string) => state.activePageId === browserPageId,
    getActivePageId: () => state.activePageId
  } as unknown as AgentBrowserBridge

  const backend = new OffscreenBrowserBackend(manager, {
    getAgentBrowserBridge: () => bridge,
    isPagePinned: (id) => overrides.pinned?.has(id) === true,
    onPagesChanged: (worktreeId) => state.pagesChanged.push(worktreeId),
    now: () => clock.value
  })

  return {
    backend,
    manager,
    bridge,
    order,
    registered,
    windows,
    clock,
    set activePageId(value: string | undefined) {
      state.activePageId = value
    },
    get pagesChanged(): (string | undefined)[] {
      return state.pagesChanged
    },
    certificateFailurePageIds: state.certificateFailurePageIds,
    downloadingPageIds: state.downloadingPageIds
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 100
  process.env.ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT = '2'
  process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '60000'
  process.env.ORCA_HEADLESS_BROWSER_PARK_GRACE_MS = '5000'
})

describe('OffscreenBrowserBackend reclamation', () => {
  it('parks an idle page: renderer destroyed, page kept and listed', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]

    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual([pageId])

    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.registered.has(pageId)).toBe(false)
    expect(h.backend.listParkedPages()).toEqual([
      {
        browserPageId: pageId,
        worktreeId: undefined,
        profileId: 'default',
        url: 'https://example.test/a',
        title: `title-${h.windows[0].webContents.id}`,
        active: false,
        loadError: null
      }
    ])
  })

  it('tears the helper session down before the mapping and the renderer go away', async () => {
    // Why (STA-4341): the headless close path used to skip the bridge entirely,
    // so every closed page left its agent-browser session and CDP proxy behind.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.order.length = 0

    await h.backend.closeTab(pageId)

    expect(h.order).toEqual([
      `session-destroy:${h.windows[0].webContents.id}`,
      `unregister:${pageId}`
    ])
    expect(h.windows[0].isDestroyed()).toBe(true)
  })

  it('tears the helper session down when parking too', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.order.length = 0

    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.order).toEqual([
      `session-destroy:${h.windows[0].webContents.id}`,
      `unregister:${pageId}`
    ])
  })

  it('wakes a parked page under the same id and reloads where it left off', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.windows[0].navigateTo('https://example.test/moved')

    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    h.order.length = 0
    loadOffscreenBrowserUrl.mockClear()

    expect(await h.backend.wakeTab(pageId)).toBe(true)

    const wokenId = h.windows[1].webContents.id
    expect(h.windows).toHaveLength(2)
    expect(h.registered.get(pageId)).toBe(wokenId)
    expect(h.order).toEqual([`register:${pageId}:${wokenId}`, `process-swap:${pageId}:${wokenId}`])
    expect(loadOffscreenBrowserUrl).toHaveBeenCalledWith(
      h.windows[1],
      'https://example.test/moved',
      OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS
    )
    expect(h.backend.listParkedPages()).toEqual([])
  })

  it('keeps the requested address when a page parks before committing one', async () => {
    // Why: a page whose load never committed must still wake to the address the
    // agent asked for, not to the blank page the window started on.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/slow', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('https://example.test/slow')
  })

  it('never parks a page whose navigation is still in flight', async () => {
    let finishLoad = (): void => {}
    loadOffscreenBrowserUrl.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (finishLoad = resolve))
    )
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/slow', browserPageId: 'a' })

    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual([])

    finishLoad()
    await Promise.resolve()
    await Promise.resolve()
    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual(['a'])
  })

  it('does not park a page that was used while an earlier park was in flight', async () => {
    // Why: parking awaits helper-session teardown, so a page later in the
    // selection can be woken and driven before its turn comes. The selection is
    // a proposal, not a licence.
    let releaseFirstTeardown = (): void => {}
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    h.clock.value += 10_000
    const bridge = h.bridge as unknown as { onTabClosed: ReturnType<typeof vi.fn> }
    bridge.onTabClosed.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseFirstTeardown = resolve))
    )

    const sweep = h.backend.reclaimIdlePages()
    await Promise.resolve()
    // b is next in line to park; a command lands on it while a is tearing down.
    await h.backend.wakeTab('b')
    releaseFirstTeardown()

    expect(await sweep).toEqual(['a'])
    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['a'])
  })

  it('does not park a page whose wake is still rebuilding it', async () => {
    // Why: a wake is resident but not yet loading while it awaits the process
    // swap, so without an explicit pin the sweep can destroy it mid-rebuild.
    let releaseSwap = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const bridge = h.bridge as unknown as { onProcessSwap: ReturnType<typeof vi.fn> }
    bridge.onProcessSwap.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseSwap = resolve))
    )
    const wake = h.backend.wakeTab('a')
    await Promise.resolve()
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual([])

    releaseSwap()
    expect(await wake).toBe(true)
  })

  it('does not let a slow close unregister a page that reused its id', async () => {
    // Why: closing drops the record before teardown finishes, so a caller
    // reusing the id could register a renderer the old close then unregisters,
    // leaving the new page unreachable by every command.
    let releaseTeardown = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    const bridge = h.bridge as unknown as { onTabClosed: ReturnType<typeof vi.fn> }
    bridge.onTabClosed.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseTeardown = resolve))
    )

    const close = h.backend.closeTab('a')
    await Promise.resolve()
    const recreate = h.backend.createTab({ url: 'https://a2', browserPageId: 'a' })
    releaseTeardown()
    await close
    await recreate

    expect(h.registered.get('a')).toBe(h.windows[1].webContents.id)
    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.windows[1].isDestroyed()).toBe(false)
  })

  it('tells the session snapshot when a parked page is closed', async () => {
    // Why: a parked close has no WebContents teardown to piggyback on, so
    // nothing else would tell paired clients the tab is gone.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    h.pagesChanged.length = 0

    await h.backend.closeTab('a')

    expect(h.pagesChanged).toEqual(['wt-1'])
  })

  it('does not park a page that is still writing a download', async () => {
    // Why: releasing a renderer unregisters its guest, and browser-manager
    // cancels that page's in-flight downloads on unregister. The desktop guest
    // budget vetoes eviction for the same reason.
    const h = createHarness({ downloadingPageIds: ['a'] })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual([])

    h.downloadingPageIds.delete('a')
    expect(await h.backend.reclaimIdlePages()).toEqual(['a'])
  })

  it('does not park a page waiting on a certificate decision', async () => {
    // Why: the challenge id dies with the renderer, so parking would discard
    // both the warning and the ability to approve it.
    const h = createHarness({ certificateFailurePageIds: ['a'] })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual([])

    h.certificateFailurePageIds.delete('a')
    expect(await h.backend.reclaimIdlePages()).toEqual(['a'])
  })

  it('parks a page whose navigation never completes so the cap cannot be defeated', async () => {
    // Why: a page can stay navigating forever (a server that accepts and never
    // finishes). Pinning on that would let one stalled create per page hold a
    // renderer indefinitely, which is the exact failure this reclaimer exists
    // to prevent. Waking simply retries the address.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.windows[0].__loading = true
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual(['a'])
    expect(h.backend.listParkedPages()[0]?.url).toBe('https://a')
  })

  it('abandons a wake whose page was closed and replaced underneath it', async () => {
    // Why: reporting success then would hand the original command a different
    // page under the name it asked for.
    let releaseSwap = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const bridge = h.bridge as unknown as { onProcessSwap: ReturnType<typeof vi.fn> }
    bridge.onProcessSwap.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseSwap = resolve))
    )
    const wake = h.backend.wakeTab('a')
    await Promise.resolve()
    await h.backend.closeTab('a')
    await h.backend.createTab({ url: 'https://replacement', browserPageId: 'a' })
    releaseSwap()

    expect(await wake).toBe(false)
  })

  it('ignores a subframe in-page navigation when recording the address', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://host.test/', browserPageId: 'a' })
    h.windows[0].navigateTo('https://frame.test/#x', false)
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('https://host.test/')
  })

  it('does not let a wake outlast the RPC budget a paired client gives it', async () => {
    // Why: a wake happens inside browser.tabShow, which the paired client caps
    // at 15s. Waiting out the full 30s load budget would report the browser
    // unreachable on any page slower than that; the page is operable and still
    // navigating when the wake returns, exactly as a freshly created tab is.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    const createTimeout = loadOffscreenBrowserUrl.mock.calls.at(-1)?.[2]
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    loadOffscreenBrowserUrl.mockClear()

    await h.backend.wakeTab('a')

    const wakeTimeout = loadOffscreenBrowserUrl.mock.calls.at(-1)?.[2]
    expect(wakeTimeout).toBe(OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS)
    expect(OFFSCREEN_BROWSER_WAKE_LOAD_BUDGET_MS).toBeLessThan(15_000)
    // A fresh create keeps the longer budget; nothing is waiting on it.
    expect(createTimeout).toBeUndefined()
  })

  it('arms no timer once nothing is resident, and re-arms on wake', async () => {
    // Why: an idle headless host should hold no reclaim timer at all. Waking has
    // to re-arm it or the woken page would never be reclaimed again.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    const reclaimer = (h.backend as unknown as { reclaimer: { isScheduled: boolean } }).reclaimer
    expect(reclaimer.isScheduled).toBe(true)

    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    expect(h.backend.listParkedPages()).toHaveLength(1)
    expect(reclaimer.isScheduled).toBe(false)

    await h.backend.wakeTab('a')
    expect(reclaimer.isScheduled).toBe(true)
  })

  it('coalesces concurrent wakes into one renderer', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const [first, second] = await Promise.all([
      h.backend.wakeTab(pageId),
      h.backend.wakeTab(pageId)
    ])

    expect([first, second]).toEqual([true, true])
    expect(h.windows).toHaveLength(2)
  })

  it('owns no page and no renderer when materialization fails', async () => {
    // Why: a create that never produced a usable renderer must not occupy the
    // retention budget, be listed as parked, or block a retry with the same id.
    const h = createHarness()
    h.manager.registerOffscreenGuest = () => {
      throw new Error('register failed')
    }

    await expect(h.backend.createTab({ url: 'https://a', browserPageId: 'a' })).rejects.toThrow(
      'register failed'
    )

    expect(h.backend.listParkedPages()).toEqual([])
    expect(h.windows.every((win) => win.isDestroyed())).toBe(true)
    // The id is free again, so a retry is not rejected as already existing.
    h.manager.registerOffscreenGuest = (({
      browserPageId,
      webContentsId
    }: {
      browserPageId: string
      webContentsId: number
    }) => {
      h.registered.set(browserPageId, webContentsId)
    }) as typeof h.manager.registerOffscreenGuest
    await expect(h.backend.createTab({ url: 'https://a', browserPageId: 'a' })).resolves.toEqual({
      browserPageId: 'a'
    })
  })

  it('makes a second wake wait for the first to finish rebuilding', async () => {
    // Why: materialize sets the window before the session swap and the reload,
    // so the page looks resident long before it is usable.
    let releaseSwap = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const bridge = h.bridge as unknown as { onProcessSwap: ReturnType<typeof vi.fn> }
    bridge.onProcessSwap.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseSwap = resolve))
    )
    const first = h.backend.wakeTab('a')
    await Promise.resolve()
    await Promise.resolve()

    let secondSettled = false
    const second = h.backend.wakeTab('a').then((value) => {
      secondSettled = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    releaseSwap()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  it('does not let an abandoned wake clear a replacement page wake lock', async () => {
    // Why: dropping the replacement's lock would let the next command see a
    // live window with no wake in flight and drive a half-rebuilt renderer.
    let releaseFirstSwap = (): void => {}
    let releaseSecondSwap = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const bridge = h.bridge as unknown as { onProcessSwap: ReturnType<typeof vi.fn> }
    bridge.onProcessSwap.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseFirstSwap = resolve))
    )
    const abandoned = h.backend.wakeTab('a')
    await Promise.resolve()

    await h.backend.closeTab('a')
    await h.backend.createTab({ url: 'https://replacement', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    bridge.onProcessSwap.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (releaseSecondSwap = resolve))
    )
    const replacementWake = h.backend.wakeTab('a')
    await Promise.resolve()

    // The old wake finishing must not release the replacement's lock.
    releaseFirstSwap()
    expect(await abandoned).toBe(false)

    let thirdSettled = false
    const third = h.backend.wakeTab('a').then((value) => {
      thirdSettled = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdSettled).toBe(false)

    releaseSecondSwap()
    expect(await replacementWake).toBe(true)
    expect(await third).toBe(true)
  })

  it('reports false when waking a page it does not own', async () => {
    const h = createHarness()
    expect(await h.backend.wakeTab('nope')).toBe(false)
  })

  it('does not park a pinned page even when it is the oldest', async () => {
    const h = createHarness({ pinned: new Set(['streamed']) })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'streamed' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'idle' })
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual(['idle'])
  })

  it('keeps the resident cap by evicting least-recently-used pages', async () => {
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://example.test/${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    // Why: past the grace floor but well inside the idle window, so the cap is
    // provably the evictor here.
    h.clock.value += 10_000

    expect(await h.backend.reclaimIdlePages()).toEqual(['a', 'b'])
    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['a', 'b'])
  })

  it('remembers whether a page was active when it parked, and forgets on wake', async () => {
    // Why: the paired client's tab bar reads the session snapshot; a park must
    // not silently deselect the tab the user had open.
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(
      h.backend.listParkedPages().map((page) => [page.browserPageId, page.active === true])
    ).toEqual([
      ['a', true],
      ['b', false]
    ])

    await h.backend.wakeTab('a')
    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['b'])
  })

  it('keeps an intentional navigation to about:blank across a park', async () => {
    // Why: an in-page `location.href = "about:blank"` is a real destination.
    // Sniffing the address at park time could not tell it apart from the blank
    // page a window starts on, so the record follows navigation instead.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.windows[0].navigateTo('about:blank')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('about:blank')
  })

  it('ignores a chrome-error address so a wake retries the real one', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.windows[0].navigateTo('chrome-error://chromewebdata/')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('https://example.test/a')
  })

  it('carries a load failure onto the parked record', async () => {
    // Why: reclaiming a renderer does not make a page that failed to load
    // healthy, and the failure is unreadable once the guest is unregistered.
    const loadError = { code: -105, description: 'NAME_NOT_RESOLVED', validatedUrl: 'https://nope' }
    const h = createHarness({ loadError })
    await h.backend.createTab({ url: 'https://nope', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.loadError).toEqual(loadError)
  })

  it('lets only the newest claim hold the parked active flag', async () => {
    // Why: parking the active page promotes another live tab to active, which
    // then parks claiming the flag too. `active` is a single selection.
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    // Simulate the promotion: b is now the active page and parks claiming it.
    h.activePageId = 'b'
    await h.backend.wakeTab('b')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const claimed = h.backend.listParkedPages().filter((page) => page.active)
    expect(claimed.map((page) => page.browserPageId)).toEqual(['b'])
  })

  it('lists open page ids in creation order across parks and wakes', async () => {
    // Why: the merged tab listing sorts by this order; if it drifted with
    // residency, a background park would renumber indices callers already read.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    await h.backend.wakeTab('a')

    expect(h.backend.listOpenPageIds('wt-1')).toEqual(['a', 'b'])
    expect(h.backend.listOpenPageIds()).toEqual(['a', 'b'])
  })

  it('does not promote a parked page while a live tab holds active', async () => {
    // Why: promotion exists for the no-live-active gap only; a live active tab
    // already gives the listing its selection, and a parked page claiming it
    // too would put two stars on the worktree.
    const h = createHarness({ activePageId: 'live' })
    await h.backend.createTab({
      url: 'https://parked',
      browserPageId: 'parked',
      worktreeId: 'wt-1'
    })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://live', browserPageId: 'live', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({
      url: 'https://doomed',
      browserPageId: 'doomed',
      worktreeId: 'wt-1'
    })
    h.clock.value += 120_000
    await h.backend.wakeTab('live')
    await h.backend.wakeTab('doomed')
    await h.backend.reclaimIdlePages()

    await h.backend.closeTab('doomed')

    expect(
      h.backend.listParkedPages('wt-1').map((page) => [page.browserPageId, page.active === true])
    ).toEqual([['parked', false]])
  })

  it('hands the active flag to a survivor when the parked holder closes', async () => {
    // Why: closing a parked page has no bridge teardown to promote a successor,
    // so without this the worktree's every remaining tab reports inactive and a
    // paired client loses its one-selected-tab assumption.
    const h = createHarness({ activePageId: 'b' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    h.activePageId = undefined

    await h.backend.closeTab('b')

    expect(
      h.backend.listParkedPages('wt-1').map((page) => [page.browserPageId, page.active === true])
    ).toEqual([['a', true]])
  })

  it('scopes the parked active claim to its worktree, undefined included', async () => {
    // Why: a remote `tab create` without --worktree makes a worktree-less page;
    // parking it while active must not wipe another worktree's parked flag.
    const h = createHarness({ activePageId: 'w' })
    await h.backend.createTab({ url: 'https://w', browserPageId: 'w', worktreeId: 'wt-1' })
    await h.backend.createTab({ url: 'https://g', browserPageId: 'g' })
    h.clock.value += 120_000
    await h.backend.wakeTab('g')
    await h.backend.reclaimIdlePages()
    h.activePageId = 'g'
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(
      h.backend.listParkedPages('wt-1').map((page) => [page.browserPageId, page.active === true])
    ).toEqual([['w', true]])
    expect(
      h.backend
        .listParkedPages()
        .filter((page) => page.active)
        .map((page) => page.browserPageId)
        .sort()
    ).toEqual(['g', 'w'])
    // Why: with one flag per scope, a scope-less implicit command must target
    // the page that held the MOST RECENT active claim — not the oldest scope's
    // page just because it comes first in creation order.
    expect(h.backend.getParkedPageIdForImplicitTarget()).toBe('g')
  })

  it('promotes for a scope even while another worktree has a resident page', async () => {
    // Why: the promotion gate is per scope. A live tab elsewhere on the host
    // says nothing about this worktree's selection.
    const h = createHarness({ activePageId: 'holder' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({
      url: 'https://holder',
      browserPageId: 'holder',
      worktreeId: 'wt-1'
    })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://other', browserPageId: 'other', worktreeId: 'wt-2' })
    h.clock.value += 120_000
    await h.backend.wakeTab('other')
    await h.backend.reclaimIdlePages()
    h.activePageId = undefined

    await h.backend.closeTab('holder')

    expect(
      h.backend.listParkedPages('wt-1').map((page) => [page.browserPageId, page.active === true])
    ).toEqual([['a', true]])
  })

  it('targets the page that was active, not merely the most recently used', async () => {
    // Why: an explicit `--page b` command makes b the most recently used while
    // a is still the active tab, and a page-less command means "the active tab".
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.getParkedPageIdForImplicitTarget('wt-1')).toBe('a')
  })

  it('reports the most recently used parked page for implicit targeting', async () => {
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://example.test/${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    h.clock.value += 10_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.getParkedPageIdForImplicitTarget()).toBe('b')
  })

  it('restarts the reclaim clock when a resident page is used', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.clock.value += 120_000

    // Why: waking a resident page must not rebuild its renderer, only mark it used.
    expect(await h.backend.wakeTab('a')).toBe(true)
    expect(h.windows).toHaveLength(1)
    expect(await h.backend.reclaimIdlePages()).toEqual([])
  })

  it('does not let a command land on a renderer that a park is tearing down', async () => {
    let releaseSession = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    const bridge = h.bridge as unknown as { onTabClosed: ReturnType<typeof vi.fn> }
    bridge.onTabClosed.mockImplementation(
      async () => new Promise<void>((resolve) => (releaseSession = resolve))
    )

    h.clock.value += 120_000
    const park = h.backend.reclaimIdlePages()
    const wake = h.backend.wakeTab('a')
    releaseSession()
    await park
    expect(await wake).toBe(true)

    // The woken renderer is a fresh one, not the window the park destroyed.
    expect(h.windows).toHaveLength(2)
    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.windows[1].isDestroyed()).toBe(false)
    expect(h.registered.get('a')).toBe(h.windows[1].webContents.id)
    // Why: the park resumes after the wake re-materialized the window. It must
    // not null the fresh window off the record — that leaks the renderer (no
    // reference left for close/destroyAll), lists the page as parked and live
    // at once, and reports the wake successful against a blank page.
    expect(h.backend.listParkedPages()).toEqual([])
    expect(loadOffscreenBrowserUrl.mock.calls.some(([win]) => win === h.windows[1])).toBe(true)
  })

  it('keeps a parked page after its renderer emits destroyed', async () => {
    // Why: parking destroys the window on purpose; the crash handler must not
    // read that as the page going away or the record is lost.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['a'])
  })

  it('drops a page whose renderer dies on its own and reclaims its helper session', async () => {
    // Why: without this the crash path leaks one helper session, CDP proxy and
    // listening port per lost renderer — a crash loop is unbounded.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    const webContentsId = h.windows[0].webContents.id
    h.order.length = 0

    h.windows[0].destroy()
    await Promise.resolve()

    expect(h.order).toEqual([`session-destroy:${webContentsId}`, 'unregister:a'])
    expect(h.backend.listParkedPages()).toEqual([])
    expect(await h.backend.wakeTab('a')).toBe(false)
  })

  it('scopes parked listings and implicit targeting to a worktree', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-2' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages('wt-1').map((page) => page.browserPageId)).toEqual(['a'])
    expect(h.backend.getParkedPageIdForImplicitTarget('wt-2')).toBe('b')
  })

  it('destroys every page it owns on shutdown', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b' })

    h.backend.destroyAll()

    expect(h.windows.every((win) => win.isDestroyed())).toBe(true)
    expect(h.backend.listParkedPages()).toEqual([])
  })
})
