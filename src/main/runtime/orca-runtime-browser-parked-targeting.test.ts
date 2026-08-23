import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend, ParkedBrowserPage } from '../browser/browser-backend'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

// Why (STA-4341): a headless listing spans resident and parked pages, so every
// index-addressed command has to resolve against that listing — and resolve it
// before any implicit wake reorders it. These drive the shipping runtime methods
// against a backend that models park/wake the way the real one behaves.

const { webContentsFromIdMock, browserSessionRegistryMock, browserManagerMock } = vi.hoisted(
  () => ({
    webContentsFromIdMock: vi.fn(),
    browserSessionRegistryMock: {
      getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'p', label: 'Default' })),
      getProfile: vi.fn(() => ({ id: 'default', partition: 'p', label: 'Default' }))
    },
    browserManagerMock: {
      getSessionProfileIdForTab: vi.fn(() => 'default'),
      getWorktreeIdForTab: vi.fn(() => 'wt-1')
    }
  })
)

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromIdMock }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))
vi.mock('../browser/browser-manager', () => ({
  browserManager: browserManagerMock,
  browserCertificateTrustController: {}
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast: vi.fn() }))
vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn(async () => {}),
  waitForWorktreeTabRegistration: vi.fn(async () => {})
}))

type FakeHeadlessHost = {
  host: RuntimeBrowserCommandHost
  /** Pages with a live renderer, in bridge listing order. */
  livePageIds: string[]
  /** Parked pages, most-recently-used last. */
  parkedPageIds: string[]
  wakeCalls: string[]
  switchCalls: { worktreeId?: string; browserPageId?: string; index?: number }[]
  closedPageIds: string[]
}

function createFakeHeadlessHost(
  live: string[],
  parked: string[],
  // Why a separate order: creation order is what the real page book carries;
  // live-then-parked only coincides with it until something parks.
  creationOrder: string[] = [...live, ...parked]
): FakeHeadlessHost {
  const state: FakeHeadlessHost = {
    host: null as unknown as RuntimeBrowserCommandHost,
    livePageIds: [...live],
    parkedPageIds: [...parked],
    wakeCalls: [],
    switchCalls: [],
    closedPageIds: []
  }

  const bridge = {
    tabList: () => ({
      tabs: state.livePageIds.map((browserPageId, index) => ({
        browserPageId,
        index,
        url: `https://example.test/${browserPageId}`,
        title: browserPageId,
        active: index === 0
      }))
    }),
    getRegisteredTabs: () => new Map(state.livePageIds.map((id, index) => [id, 100 + index])),
    getActivePageId: () => state.livePageIds[0] ?? null,
    getActiveWebContentsId: () => (state.livePageIds.length > 0 ? 100 : null),
    tabSwitch: vi.fn(
      async (index: number | undefined, worktreeId?: string, browserPageId?: string) => {
        state.switchCalls.push({ index, worktreeId, browserPageId })
        const resolved = browserPageId ?? state.livePageIds[index ?? 0]
        return { switched: state.livePageIds.indexOf(resolved), browserPageId: resolved }
      }
    )
  } as unknown as AgentBrowserBridge

  const backend = {
    createTab: vi.fn(),
    closeTab: vi.fn(async (browserPageId: string) => {
      state.closedPageIds.push(browserPageId)
      state.livePageIds = state.livePageIds.filter((id) => id !== browserPageId)
      state.parkedPageIds = state.parkedPageIds.filter((id) => id !== browserPageId)
    }),
    // Why: waking makes a parked page live, which appends it to the bridge
    // listing — that reordering is exactly what an index must not be resolved
    // after.
    wakeTab: vi.fn(async (browserPageId: string) => {
      state.wakeCalls.push(browserPageId)
      if (state.parkedPageIds.includes(browserPageId)) {
        state.parkedPageIds = state.parkedPageIds.filter((id) => id !== browserPageId)
        state.livePageIds.push(browserPageId)
        return true
      }
      return state.livePageIds.includes(browserPageId)
    }),
    listParkedPages: (): ParkedBrowserPage[] =>
      state.parkedPageIds.map((browserPageId) => ({
        browserPageId,
        worktreeId: 'wt-1',
        profileId: 'default',
        url: `https://example.test/${browserPageId}`,
        title: browserPageId
      })),
    getParkedPageIdForImplicitTarget: () => state.parkedPageIds.at(-1) ?? null,
    listOpenPageIds: () =>
      creationOrder.filter(
        (id) => state.livePageIds.includes(id) || state.parkedPageIds.includes(id)
      )
  } as unknown as BrowserBackend

  state.host = {
    resolveWorktreeSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    getAuthoritativeWindow: vi.fn(() => {
      throw new Error('No renderer window available')
    }),
    getAvailableAuthoritativeWindow: () => null,
    getOffscreenBrowserBackend: () => backend,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
  return state
}

beforeEach(() => {
  webContentsFromIdMock.mockReset()
  webContentsFromIdMock.mockImplementation(() => ({ isDestroyed: () => false }))
})

describe('headless parked-page targeting', () => {
  it('lists parked pages after resident ones without waking any renderer', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b', 'parked-c'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const listed = await commands.browserTabList({ worktree: 'id:wt-1' })

    expect(listed.tabs.map((tab) => [tab.browserPageId, tab.index, tab.parked === true])).toEqual([
      ['live-a', 0, false],
      ['parked-b', 1, true],
      ['parked-c', 2, true]
    ])
    expect(fake.wakeCalls).toEqual([])
  })

  it('keeps a tab index stable when an older tab parks', async () => {
    // Why: pre-reclaim, headless indices moved only on create/close. A listing
    // ordered by residency would let a background park renumber an index the
    // agent read minutes earlier, silently retargeting its next command.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-b'], ['parked-a'], ['parked-a', 'live-b'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const listed = await commands.browserTabList({ worktree: 'id:wt-1' })

    expect(listed.tabs.map((tab) => [tab.browserPageId, tab.index, tab.parked === true])).toEqual([
      ['parked-a', 0, true],
      ['live-b', 1, false]
    ])
  })

  it('reports listing indices, not bridge registration order, from show and switch', async () => {
    // Why: a park+wake permutes the bridge's registration order. The index a
    // caller gets back must name the same tab in the listing they read, or
    // chaining it into --index addresses a different tab.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['c', 'a'], [], ['a', 'c'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const current = await commands.browserTabCurrent({ worktree: 'id:wt-1' })
    expect(current.tab.browserPageId).toBe('c')
    expect(current.tab.index).toBe(1)

    const switched = await commands.browserTabSwitch({ page: 'c', worktree: 'id:wt-1' })
    expect(switched).toMatchObject({ browserPageId: 'c', switched: 1 })
  })

  it('switches to the page the listed index named, not one an implicit wake promoted', async () => {
    // Why: with every page parked, resolving the worktree first wakes the most
    // recently used one, which makes it live and moves it to listing index 0.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost([], ['parked-a', 'parked-b'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const listedBefore = await commands.browserTabList({ worktree: 'id:wt-1' })
    expect(listedBefore.tabs[0].browserPageId).toBe('parked-a')

    const result = await commands.browserTabSwitch({ index: 0, worktree: 'id:wt-1' })

    expect(result.browserPageId).toBe('parked-a')
    expect(fake.switchCalls).toEqual([
      { index: undefined, worktreeId: 'wt-1', browserPageId: 'parked-a' }
    ])
  })

  it('reports back the index the caller passed, not the renumbered one', async () => {
    // Why: waking the target makes it live, which renumbers the bridge listing.
    // Reporting that position would describe neither the request nor the
    // listing the caller read.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b', 'parked-c'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const result = await commands.browserTabSwitch({ index: 2, worktree: 'id:wt-1' })

    expect(result).toMatchObject({ switched: 2, browserPageId: 'parked-c' })
  })

  it('counts an indexed switch of a resident page as using it', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a', 'live-b'], ['parked-c'])
    const commands = new RuntimeBrowserCommands(fake.host)

    await commands.browserTabSwitch({ index: 1, worktree: 'id:wt-1' })

    expect(fake.wakeCalls).toEqual(['live-b'])
    expect(fake.switchCalls.at(-1)?.browserPageId).toBe('live-b')
  })

  it('closes the page the listed index named when the listing is mixed', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b', 'parked-c'])
    const commands = new RuntimeBrowserCommands(fake.host)

    await commands.browserTabClose({ index: 2, worktree: 'id:wt-1' })

    expect(fake.closedPageIds).toEqual(['parked-c'])
  })

  it('resolves `tab current` when the only page is parked', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost([], ['parked-a'])
    const commands = new RuntimeBrowserCommands(fake.host)

    const current = await commands.browserTabCurrent({ worktree: 'id:wt-1' })

    expect(current.tab.browserPageId).toBe('parked-a')
    expect(fake.wakeCalls).toContain('parked-a')
  })

  it('counts `tab current` as using the page it names', async () => {
    // Why: without this an agent could poll `tab current` continuously and
    // still have that very page reclaimed under it.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], [])
    const commands = new RuntimeBrowserCommands(fake.host)

    await commands.browserTabCurrent({ worktree: 'id:wt-1' })

    expect(fake.wakeCalls).toEqual(['live-a'])
  })

  it('closes a parked page by index without rebuilding its renderer', async () => {
    // Why: waking a page only to destroy it is pure churn, and a wake that
    // fails would turn a reclaimable page into an unclosable one.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b'])
    const commands = new RuntimeBrowserCommands(fake.host)

    await commands.browserTabClose({ index: 1, worktree: 'id:wt-1' })

    expect(fake.closedPageIds).toEqual(['parked-b'])
    expect(fake.wakeCalls).toEqual([])
  })

  it('pins a page for the reclaimer exactly while a client streams it', async () => {
    // Why: the reclaimer's streamed-page veto rides on this signal; if it goes
    // false while a stream runs, a watched pane blacks out mid-view.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const { startBrowserScreencast } = await import('../browser/browser-screencast-stream')
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    vi.mocked(startBrowserScreencast).mockResolvedValue({
      stop: vi.fn(() => resolveDone()),
      done
    } as never)
    const fake = createFakeHeadlessHost(['live-a'], [])
    const commands = new RuntimeBrowserCommands(fake.host)
    expect(commands.isBrowserPageStreamed('live-a')).toBe(false)

    const started = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'live-a', format: 'jpeg' },
      { sendBinary: vi.fn() }
    )
    expect(commands.isBrowserPageStreamed('live-a')).toBe(true)

    started.session.stop()
    await started.session.done
    expect(commands.isBrowserPageStreamed('live-a')).toBe(false)
  })

  it('closes a parked page by explicit id without rebuilding its renderer', async () => {
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b'])
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const commands = new RuntimeBrowserCommands(fake.host)

    await commands.browserTabClose({ page: 'parked-b', worktree: 'id:wt-1' })

    expect(fake.closedPageIds).toEqual(['parked-b'])
    expect(fake.wakeCalls).toEqual([])
  })

  it('counts a stream ending as page use so the idle clock restarts then', async () => {
    // Why: streaming pins the page but frames are not activity, so a client
    // that only watched for longer than the idle window would otherwise have
    // the page parked ~one recheck after closing the pane.
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const { startBrowserScreencast } = await import('../browser/browser-screencast-stream')
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    vi.mocked(startBrowserScreencast).mockResolvedValue({
      stop: vi.fn(() => resolveDone()),
      done
    } as never)
    const fake = createFakeHeadlessHost(['live-a'], [])
    const commands = new RuntimeBrowserCommands(fake.host)

    const started = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'live-a', format: 'jpeg' },
      { sendBinary: vi.fn() }
    )
    const wakesBeforeStop = fake.wakeCalls.length

    started.session.stop()
    await started.session.done

    await vi.waitFor(() => expect(fake.wakeCalls.length).toBeGreaterThan(wakesBeforeStop))
    expect(fake.wakeCalls.at(-1)).toBe('live-a')
  })

  it('reports a listed-index overrun against the merged listing', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const fake = createFakeHeadlessHost(['live-a'], ['parked-b'])
    const commands = new RuntimeBrowserCommands(fake.host)

    await expect(commands.browserTabClose({ index: 5, worktree: 'id:wt-1' })).rejects.toThrow(
      'Tab index 5 out of range (0-1)'
    )
  })
})
