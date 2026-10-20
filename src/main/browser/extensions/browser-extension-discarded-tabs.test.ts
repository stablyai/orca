/// <reference types="chrome" />
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { BrowserExtensionCaller } from './browser-extension-namespace-registry'

type FakeSession = { name: string }
type Guest = EventEmitter & { id: number; session: FakeSession; url: string }

const mocks = vi.hoisted(() => {
  const sessions = { default: { name: 'default' }, work: { name: 'work' } }
  const host = { id: 900 }
  const emitted: { event: string; args: unknown; session: unknown }[] = []
  return {
    sessions,
    host,
    guests: new Map<number, unknown>(),
    pageByGuest: new Map<number, string>(),
    emitted,
    activate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    extension: { id: 'e'.repeat(32), manifest: { permissions: ['tabs'] } }
  }
})

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => mocks.guests.get(id) }
}))
vi.mock('../browser-manager', () => ({
  browserManager: {
    getGuestWebContentsId: (pageId: string) =>
      [...mocks.pageByGuest].find(([, page]) => page === pageId)?.[0] ?? null,
    getWebContentsIdByTabId: () =>
      new Map([...mocks.pageByGuest].map(([id, pageId]) => [pageId, id])),
    getTabIdForWebContentsId: (id: number) => mocks.pageByGuest.get(id) ?? null,
    getWorktreeIdForTab: () => undefined
  }
}))
vi.mock('../../runtime/browser/browser-tab-renderer-create', () => ({}))
vi.mock('../../runtime/browser/browser-tab-renderer-close', () => ({
  closeBrowserTabInRenderer: mocks.close
}))
vi.mock('../../runtime/browser/browser-tab-renderer-activate', () => ({
  activateBrowserTabInRenderer: mocks.activate
}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({}))
vi.mock('./browser-extension-api-host', () => ({
  getBrowserExtensionProfileIdForSession: () => 'default',
  emitBrowserExtensionEvent: (
    target: { session: unknown },
    _namespace: string,
    event: string,
    args: unknown
  ) =>
    mocks.emitted.push({
      event,
      session: target.session,
      args: typeof args === 'function' ? args(mocks.extension) : args
    })
}))
vi.mock('./browser-extension-popup-host', () => ({ closeBrowserExtensionPopup: vi.fn() }))
vi.mock('./browser-extension-action-registry', () => ({ forgetBrowserExtensionActionTab: vi.fn() }))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('./browser-extension-session-loader', () => {
  const profile = (id: string) => (id in mocks.sessions ? { id, partition: `persist:${id}` } : null)
  return {
    getBrowserExtensionProfile: profile,
    getBrowserExtensionProfileForPartition: (partition: string) =>
      profile(partition.replace('persist:', '')),
    getBrowserExtensionSessionForProfile: (id: string) =>
      id === 'default' || id === 'work' ? mocks.sessions[id] : null
  }
})
vi.mock('./browser-extension-window-model', () => ({
  WINDOW_ID_CURRENT: -2,
  getBrowserExtensionMainWindow: () => ({ id: 1, webContents: mocks.host }),
  getBrowserExtensionWindow: () => null,
  getPopoutWindowForWebContents: () => null,
  listPopoutWindowsInSession: () => [],
  getLastFocusedBrowserExtensionWindowId: () => 1,
  listBrowserExtensionWindows: () => [{ window: { id: 1 }, type: 'normal' }],
  presentBrowserExtensionWindow: vi.fn()
}))
vi.mock('./api/tabs-capture', () => ({ captureVisibleTabMethod: {} }))

const registry = await import('./browser-extension-namespace-registry')
const discardedTabs = await import('./browser-extension-discarded-tabs')
const { recordActiveBrowserPage } = await import('./browser-extension-tab-model')
const { registerTabsNamespace } = await import('./api/tabs')
const { announceRegisteredBrowserExtensionTab, observeBrowserExtensionTabLifecycle } =
  await import('./api/tabs-lifecycle')
const { PRELOAD_FIRST_DISCARDED_TAB_ID } =
  await import('../../../preload/browser-extension-document-targets')

function page(id: string, workspaceId: string, overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId: 'wt',
    url: `https://${id}.test/`,
    title: `${id} title`,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function tab(id: string, overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt',
    url: '',
    title: '',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function session(
  tabsByKey: Record<string, BrowserWorkspace[]>,
  pages: BrowserPage[]
): WorkspaceSessionState {
  const browserPagesByWorkspace: Record<string, BrowserPage[]> = {}
  for (const entry of pages) {
    browserPagesByWorkspace[entry.workspaceId] = [
      ...(browserPagesByWorkspace[entry.workspaceId] ?? []),
      entry
    ]
  }
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    browserTabsByWorktree: tabsByKey,
    browserPagesByWorkspace
  }
}

let saved: { local: WorkspaceSessionState; ssh: WorkspaceSessionState }
let writeListener: ((hostId: ExecutionHostId | null) => void) | null = null

function guest(id: number, sess: FakeSession, url: string): Guest {
  const contents = Object.assign(new EventEmitter(), {
    id,
    session: sess,
    url,
    isDestroyed: () => false,
    getType: () => 'webview',
    hostWebContents: mocks.host,
    getURL: () => url,
    getTitle: () => 'live',
    isLoading: () => true,
    isCurrentlyAudible: () => false,
    isAudioMuted: () => false
  })
  mocks.guests.set(id, contents)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the fields stubbed above.
  observeBrowserExtensionTabLifecycle(contents as unknown as Electron.WebContents)
  return contents
}

function call(method: string, args: unknown[], sess: FakeSession = mocks.sessions.default) {
  const caller = { extension: mocks.extension, session: sess, browserProfileId: 'default' }
  return Promise.resolve().then(() =>
    registry.getBrowserExtensionNamespace('tabs')?.methods[method].invoke(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tabs methods read only the caller's extension and session.
      caller as unknown as BrowserExtensionCaller,
      args
    )
  )
}

async function query(info: chrome.tabs.QueryInfo, native: unknown[] = [], sess?: FakeSession) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tabs.query returns chrome.tabs.Tab[].
  return (await call('query', [info, native], sess)) as chrome.tabs.Tab[]
}

function events(name: string) {
  return mocks.emitted.filter((entry) => entry.event === name).map((entry) => entry.args)
}

beforeEach(() => {
  mocks.guests.clear()
  mocks.pageByGuest.clear()
  mocks.emitted.length = 0
  mocks.activate.mockClear()
  mocks.extension.manifest = { permissions: ['tabs'] }
  // Local: a git worktree and a folder workspace; a document page and another profile's tab.
  saved = {
    local: session(
      {
        'wt-1': [tab('bt-1'), tab('bt-work', { sessionProfileId: 'work' })],
        'folder:notes': [tab('bt-folder')]
      },
      [
        page('live', 'bt-1'),
        page('cold', 'bt-1'),
        page('doc', 'bt-1', {
          url: '',
          docLocation: { kind: 'workspace-doc', worktreeId: 'wt-1', filePath: '/a.md' }
        }),
        page('notes', 'bt-folder'),
        page('job', 'bt-work')
      ]
    ),
    // An SSH workspace: a page this desktop shows, and one its runtime streams.
    ssh: session({ 'wt-ssh': [tab('bt-ssh')] }, [
      page('remote', 'bt-ssh'),
      page('streamed', 'bt-ssh', { remoteBrowserPageId: 'runtime-page' })
    ])
  }
  discardedTabs.setSavedBrowserTabsSource({
    getWorkspaceSessionHostIds: () => ['local', 'ssh:box'],
    getWorkspaceSession: (hostId) => (hostId === 'ssh:box' ? saved.ssh : saved.local),
    onWorkspaceSessionWritten: (listener) => {
      writeListener = listener
      return () => {
        writeListener = null
      }
    }
  })
  discardedTabs.forgetBrowserPageGuestsGone()
  registerTabsNamespace()
  guest(11, mocks.sessions.default, 'https://live.test/')
  mocks.pageByGuest.set(11, 'live')
  recordActiveBrowserPage('live')
})

describe('restored browser pages without a guest are discarded tabs', () => {
  it('lists every unloaded page of the caller’s profile after the loaded tabs, with a stable id', async () => {
    const tabs = await query({}, [{ id: 11, url: 'https://live.test/' }])
    expect(tabs.map((entry) => [entry.url, entry.discarded, entry.status, entry.index])).toEqual([
      ['https://live.test/', false, 'loading', 0],
      ['https://cold.test/', true, 'unloaded', 1],
      ['https://notes.test/', true, 'unloaded', 3],
      ['https://remote.test/', true, 'unloaded', 4]
    ])
    const cold = tabs[1]
    expect(cold).toMatchObject({ title: 'cold title', windowId: 1, active: false })
    expect(cold.id).toBeGreaterThanOrEqual(discardedTabs.FIRST_DISCARDED_BROWSER_TAB_ID)
    expect((await query({ discarded: true })).map((entry) => entry.id)).toEqual(
      tabs.slice(1).map((entry) => entry.id)
    )
    expect(await call('get', [cold.id, null])).toMatchObject({ id: cold.id, discarded: true })
    // Electron's native query already filtered the loaded tabs by url.
    expect((await query({ url: 'https://cold.test/*' })).map((entry) => entry.id)).toEqual([
      cold.id
    ])
    // The other profile's extensions see only its own page.
    expect((await query({}, [], mocks.sessions.work)).map((entry) => entry.url)).toEqual([
      'https://job.test/'
    ])
  })

  it('hides url and title without the tabs permission or a host permission', async () => {
    mocks.extension.manifest = { permissions: [] }
    const [cold] = await query({ discarded: true })
    expect(cold).not.toHaveProperty('url')
    expect(cold).not.toHaveProperty('title')
    expect(await query({ url: 'https://cold.test/*' })).toEqual([])
  })

  it('activates through the renderer, then is replaced by the loaded guest', async () => {
    const [cold] = await query({ discarded: true })
    const coldId = cold.id!
    // Showing the page makes it active before its guest exists.
    recordActiveBrowserPage('cold')
    expect(events('onActivated')).toContainEqual([{ tabId: coldId, windowId: 1 }])
    await call('update', [coldId, { active: true }])
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'cold')

    // The guest starts loading before the renderer registers it: no onCreated for a reloaded tab.
    const loaded = guest(12, mocks.sessions.default, 'https://cold.test/')
    loaded.emit('did-start-loading')
    expect(events('onCreated')).toEqual([])
    mocks.pageByGuest.set(12, 'cold')
    announceRegisteredBrowserExtensionTab('cold', 12)
    expect(events('onReplaced')).toEqual([[12, coldId]])
    expect(events('onCreated')).toEqual([])
    expect(events('onUpdated')).toContainEqual([
      12,
      expect.objectContaining({ status: 'loading' }),
      expect.objectContaining({ id: 12 })
    ])
    // The renderer republishes the active page once registered; it is the same activation.
    const activations = events('onActivated').length
    recordActiveBrowserPage('cold')
    expect(events('onActivated')).toHaveLength(activations)
    await expect(call('get', [coldId, null])).rejects.toThrow(`No tab with id: ${coldId}.`)
    expect((await query({ discarded: true })).map((entry) => entry.url)).not.toContain(
      'https://cold.test/'
    )
  })

  it('announces a page that was never listed as a new tab', async () => {
    const fresh = guest(13, mocks.sessions.default, 'https://fresh.test/')
    fresh.emit('did-start-loading')
    mocks.pageByGuest.set(13, 'fresh')
    announceRegisteredBrowserExtensionTab('fresh', 13)
    expect(events('onCreated')).toEqual([[expect.objectContaining({ id: 13, discarded: false })]])
    expect(events('onReplaced')).toEqual([])
  })

  it('closes through the renderer', async () => {
    const [cold] = await query({ discarded: true })
    await call('remove', [cold.id])
    expect(mocks.close).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'cold', undefined)
  })

  it('does not list a closed page until the session save drops it, nor an evicted one after', async () => {
    const live = mocks.guests.get(11)
    if (!(live instanceof EventEmitter)) {
      throw new Error('missing guest')
    }
    mocks.pageByGuest.set(11, 'live')
    announceRegisteredBrowserExtensionTab('live', 11)
    mocks.pageByGuest.delete(11)
    mocks.guests.delete(11)
    live.emit('destroyed')
    const urls = async () => (await query({ discarded: true })).map((entry) => entry.url)
    // The save still lists the page: its guest is gone, but this may be a close not yet saved.
    expect(await urls()).not.toContain('https://live.test/')
    // A write that still saves the page: its guest was evicted, so it is discarded now.
    writeListener?.('local')
    expect(await urls()).toContain('https://live.test/')
  })

  it("uses the preload's first synthetic id", () => {
    expect(PRELOAD_FIRST_DISCARDED_TAB_ID).toBe(discardedTabs.FIRST_DISCARDED_BROWSER_TAB_ID)
  })
})
