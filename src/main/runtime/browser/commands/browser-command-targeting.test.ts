import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeBrowserCommands } from './browser-commands'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import type { BrowserPopupPage } from '../../../browser/guest-lifecycle/popups/browser-popup-ownership'
import type { BrowserTabBarEntry } from '../tabs/browser-tab-listing'
import { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import type { AgentBrowserExecOptions } from '../../../browser/agent-browser/helper-process/agent-browser-exec-options'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup
} from '../../../browser/agent-browser/testing/agent-browser-bridge-test-harness'
import { closeBrowserMemoryPage } from '../../../browser/guest-lifecycle/browser-page-memory'

const { native, waitRegistration, waitWorktreeRegistration } = vi.hoisted(() => ({
  native: new Map<number, ReturnType<typeof mockWebContents>>(),
  waitRegistration: vi.fn(async () => {}),
  waitWorktreeRegistration: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/command-test', getAppPath: () => '/command-test', isPackaged: false },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: (id: number) => native.get(id) }
}))
vi.mock('../../../browser/agent-browser/helper-process/agent-browser-process-environment', () => ({
  createAgentBrowserProcessEnvironment: () => ({ env: {}, ownsSocketDirectory: false }),
  pointAtEmptyAgentBrowserConfig: async () => {}
}))
vi.mock('../../../browser/agent-browser/helper-process/agent-browser-binary', () => ({
  resolveAgentBrowserBinary: () => '/unused-helper'
}))
vi.mock('../../../browser/cdp/transport/cdp-ws-proxy', () => ({
  CdpWsProxy: class {
    async start() {
      return 'ws://unused'
    }
    pointAtNextNode() {}
  }
}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitRegistration,
  waitForWorktreeTabRegistration: waitWorktreeRegistration,
  waitForTabFirstLoad: async () => {}
}))
vi.mock('../../../browser/guest-lifecycle/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: async () => null
}))
vi.mock('../../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {},
  browserCertificateTrustController: {}
}))

// Only the external helper transport is replaced; routing, queue admission and ref minting are real.
class CommandBridge extends AgentBrowserBridge {
  readonly delivered: { session: string; command: string[] }[] = []
  protected override async closeStaleAgentBrowserSession(): Promise<void> {}
  protected override async runAgentBrowserRaw(
    session: string,
    _args: string[],
    options?: AgentBrowserExecOptions
  ): Promise<string> {
    const [command]: string[][] = JSON.parse(String(options?.stdinText))
    this.delivered.push({ session, command })
    return JSON.stringify({
      success: true,
      data: command[0] === 'snapshot' ? { snapshot: 'button [ref=e1]' } : { ok: true }
    })
  }
}
overrideBridgeWebContentsLookup(
  CommandBridge.prototype,
  vi.fn((id: number) => native.get(id))
)

class CountedTabs extends Map<string, number> {
  visits = 0
  reads = 0
  override get(key: string): number | undefined {
    this.reads++
    return super.get(key)
  }
  override *[Symbol.iterator](): MapIterator<[string, number]> {
    for (const entry of super[Symbol.iterator]()) {
      this.visits++
      yield entry
    }
  }
}
const ownedPages = new Set<string>()
function fixture(pages: [string, string][], tabs = new CountedTabs()) {
  const worktrees = new Map<string, string>()
  const register = (page: string, worktree: string) => {
    const id = native.size + 100
    native.set(id, mockWebContents(id))
    tabs.set(page, id)
    worktrees.set(page, worktree)
    ownedPages.add(page)
    return id
  }
  for (const [page, worktree] of pages) {
    register(page, worktree)
  }
  const popups: BrowserPopupPage[] = []
  const bridge = new CommandBridge(
    mockBrowserManager(tabs, worktrees, { getPopupPages: () => popups })
  )
  const catalog: BrowserTabBarEntry[] = []
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the command seam uses only these host surfaces.
  const host = {
    getAgentBrowserBridge: () => bridge,
    resolveWorkspaceSelector: async (id: string) => ({ id }),
    getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined }),
    readBrowserTabBar: () => catalog,
    getAuthoritativeWindow: () => ({ webContents: { send } })
  } as unknown as RuntimeBrowserCommandHost
  return {
    commands: new RuntimeBrowserCommands(host),
    bridge,
    tabs,
    worktrees,
    catalog,
    send,
    register,
    popups
  }
}
afterEach(() => {
  for (const page of ownedPages) {
    closeBrowserMemoryPage(page)
  }
  ownedPages.clear()
  native.clear()
  waitRegistration.mockReset()
  waitWorktreeRegistration.mockReset()
})

it('rejects omitted-scope text mutations before delivery, while explicit and single-worktree targets work', async () => {
  const f = fixture([
    ['A', 'W1'],
    ['B', 'W2']
  ])
  f.bridge.setActiveTab(101, 'W2')
  await expect(f.commands.browserKeyboardInsertText({ text: 'draft' })).rejects.toMatchObject({
    code: 'browser_target_ambiguous'
  })
  expect(f.bridge.delivered).toEqual([])
  await expect(
    f.commands.browserKeyboardInsertText({ text: 'wrong', page: 'B', worktree: 'W1' })
  ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
  expect(f.bridge.delivered).toEqual([])
  await f.commands.browserKeyboardInsertText({ text: 'explicit', page: 'A' })
  await f.commands.browserKeyboardInsertText({ text: 'scoped', worktree: 'W2' })
  f.tabs.delete('B')
  await f.commands.browserKeyboardInsertText({ text: 'single' })
  expect(f.bridge.delivered).toEqual([
    { session: 'orca-tab-A', command: ['keyboard', 'inserttext', 'explicit'] },
    { session: 'orca-tab-B', command: ['keyboard', 'inserttext', 'scoped'] },
    { session: 'orca-tab-A', command: ['keyboard', 'inserttext', 'single'] }
  ])
})

it('keeps pinned A refs from clicking active B through an omitted-page command', async () => {
  const f = fixture([
    ['A', 'W'],
    ['B', 'W']
  ])
  f.bridge.setActiveTab(101, 'W')
  await f.commands.browserSnapshot({ page: 'B' })
  await f.commands.browserSnapshot({ page: 'A' })
  await expect(f.commands.browserClick({ worktree: 'W', element: '@e1' })).rejects.toMatchObject({
    code: 'browser_stale_ref'
  })
  expect(f.bridge.delivered.map((item) => item.command[0])).toEqual(['snapshot', 'snapshot'])
  await f.commands.browserClick({ page: 'A', worktree: 'W', element: '@e1' })
  await f.commands.browserSnapshot({ worktree: 'W' })
  await f.commands.browserClick({ worktree: 'W', element: '@e1' })
  expect(
    f.bridge.delivered.filter((item) => item.command[0] === 'click').map((item) => item.session)
  ).toEqual(['orca-tab-A', 'orca-tab-B'])
})

it('wakes the selected cold Y, without pinning the first saved X or changing command scope', async () => {
  const f = fixture([])
  f.catalog.push(
    ...['X', 'Y'].map((browserPageId) => ({
      browserPageId,
      worktreeId: 'W',
      title: browserPageId,
      url: 'https://example.com',
      loadError: null,
      certificateFailure: null
    }))
  )
  f.send.mockImplementation((_channel, payload) => {
    expect(payload).toEqual({ worktreeId: 'W' })
    f.bridge.setActiveTab(f.register('Y', 'W'), 'W')
  })
  await expect(f.commands.browserSnapshot({ worktree: 'W' })).resolves.toMatchObject({
    browserPageId: 'Y'
  })
  expect(f.tabs.has('X')).toBe(false)
})

it.each(['popup-999', 'closed-page'])(
  'returns normal not-found for %s without waking or waiting for registration',
  async (page) => {
    const f = fixture([])
    await expect(f.commands.browserSnapshot({ page })).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: `Browser page ${page} was not found`
    })
    expect(f.send).not.toHaveBeenCalled()
    expect(waitRegistration).not.toHaveBeenCalled()
    expect(f.bridge.delivered).toEqual([])
  }
)

it('authorizes a live popup through its opener and rejects another worktree', async () => {
  const f = fixture([['opener', 'W']])
  native.set(999, Object.assign(mockWebContents(999), { once: vi.fn() }))
  f.popups.push({ browserPageId: 'popup-999', webContentsId: 999, openerBrowserPageId: 'opener' })
  await expect(
    f.commands.browserSnapshot({ page: 'popup-999', worktree: 'elsewhere' })
  ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
  expect(f.bridge.delivered).toEqual([])
  await expect(
    f.commands.browserSnapshot({ page: 'popup-999', worktree: 'W' })
  ).resolves.toMatchObject({ browserPageId: 'popup-999' })
  expect(f.send).not.toHaveBeenCalled()
})

it('reports normal not-found when a saved page disappears during activation', async () => {
  const f = fixture([])
  f.catalog.push({
    browserPageId: 'closed',
    worktreeId: 'W',
    title: 'Closed',
    url: 'https://example.com',
    loadError: null,
    certificateFailure: null
  })
  waitRegistration.mockRejectedValueOnce(new Error('Tab registration timed out'))
  await expect(f.commands.browserSnapshot({ page: 'closed' })).rejects.toMatchObject({
    code: 'browser_tab_not_found',
    message: 'Browser page closed was not found'
  })
  expect(f.bridge.delivered).toEqual([])
})

it.each([200, 2000])(
  'does no added fleet traversal for a settled explicit snapshot among %i guests',
  async (size) => {
    const f = fixture([['P', 'W']])
    for (let i = 1; i < size; i++) {
      f.register(`unrelated-${i}`, 'elsewhere')
    }
    await f.commands.browserSnapshot({ page: 'P' })
    f.tabs.visits = 0
    f.tabs.reads = 0
    const baseline = await f.bridge.snapshot(undefined, 'P')
    const baselineVisits = f.tabs.visits
    const baselineReads = f.tabs.reads
    f.tabs.visits = 0
    f.tabs.reads = 0
    const admitted = await f.commands.browserSnapshot({ page: 'P' })
    expect(admitted).toEqual(baseline)
    // The existing reverse lookup when snapshot mints refs visits P once; admission visits none.
    expect(baselineVisits).toBe(1)
    expect(f.tabs.visits).toBe(1)
    expect(f.tabs.reads - baselineReads).toBe(4)
  }
)
