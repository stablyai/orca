import { describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'

vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: { resolveKnownPartition: () => 'persist:orca-browser' }
}))

const mocks = vi.hoisted(() => ({
  isMain: true,
  createBrowserTabInRenderer: vi.fn(async (..._args: unknown[]) => ({ browserPageId: 'page-2' }))
}))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.isMain
  }
}))
vi.mock('./browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: mocks.createBrowserTabInRenderer
}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn(async () => {})
}))

/** A host with no window unless `hasWindow`: the offscreen backend runs the page and served tabs save it. */
function headlessCreation(hasWindow = false) {
  const opened = vi.fn()
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => ({
    browserPageId: browserPageId ?? 'minted-page'
  }))
  const creation = new RuntimeBrowserTabCreation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offscreen create reads only the members stubbed here.
    {
      getAgentBrowserBridge: () => null,
      resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserNetworkExecutionHost: vi.fn(),
      getBrowserHostLeaseRegistry: vi.fn(),
      getRuntimeBrowserPageRegistry: vi.fn(),
      getAvailableAuthoritativeWindow: () => (hasWindow ? {} : null),
      getOffscreenBrowserBackend: () => ({ createTab, closeTab: vi.fn() }),
      getAuthoritativeWindow: () => null,
      markHeadlessBrowserSessionTabActive: vi.fn(),
      notifyHeadlessBrowserSessionTabsChanged: vi.fn(),
      serveBrowserTabs: { opened, start: vi.fn() }
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offscreen create calls no command target.
    {
      requireAgentBrowserBridge: () => ({
        getRegisteredTabs: () => new Map(),
        setActiveTab: vi.fn()
      }),
      notifyRendererNavigation: vi.fn()
    } as never
  )
  return { creation, opened }
}

describe('a browser create on a host with no window', () => {
  it('names the tab a new page joins to the served tabs', async () => {
    const host = headlessCreation()

    await host.creation.browserTabCreate({
      worktree: 'id:wt-1',
      url: 'https://example.com/b',
      page: 'page-2',
      browserTabId: 'tab-1'
    })

    expect(host.opened).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      pageId: 'page-2',
      url: 'https://example.com/b',
      title: '',
      browserTabId: 'tab-1'
    })
  })

  it('names no tab when the create asks for a new one', async () => {
    const host = headlessCreation()

    await host.creation.browserTabCreate({ worktree: 'id:wt-1', url: 'https://example.com/' })

    expect(host.opened).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      pageId: 'minted-page',
      url: 'https://example.com/',
      title: ''
    })
  })
})

describe('a browser create on a host with a window', () => {
  const join = { worktree: 'id:wt-1', url: 'https://example.com/b', page: 'page-2' }

  it('asks its window to add the page to the tab a paired desktop named', async () => {
    mocks.isMain = true
    mocks.createBrowserTabInRenderer.mockClear()

    await headlessCreation(true).creation.browserTabCreate({ ...join, browserTabId: 'tab-1' })

    expect(mocks.createBrowserTabInRenderer).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.com/b',
      'wt-1',
      undefined,
      undefined,
      false,
      'page-2',
      'tab-1'
    )
  })

  it('names no tab to its window with the switch off', async () => {
    mocks.isMain = false
    mocks.createBrowserTabInRenderer.mockClear()

    await headlessCreation(true).creation.browserTabCreate({ ...join, browserTabId: 'tab-1' })

    expect(mocks.createBrowserTabInRenderer.mock.calls[0]?.[7]).toBeUndefined()
    mocks.isMain = true
  })
})
