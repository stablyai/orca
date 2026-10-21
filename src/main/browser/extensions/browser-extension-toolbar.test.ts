import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeSession = { name: string }
type FakeContents = { id: number; session: FakeSession; isDestroyed: () => boolean }

const mocks = vi.hoisted(() => {
  const emitted: { session: unknown; event: string; args: unknown }[] = []
  const state: { activeTabId: number | null } = { activeTabId: null }
  return {
    contents: new Map<number, { id: number; session: object; isDestroyed: () => boolean }>(),
    tabIds: new Set<number>(),
    state,
    grant: vi.fn(),
    emitted
  }
})

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => mocks.contents.get(id) }
}))
vi.mock('../browser-manager', () => ({ browserManager: {} }))
vi.mock('./browser-extension-api-host', () => ({
  getBrowserExtensionProfileIdForSession: () => 'profile',
  emitBrowserExtensionEvent: (
    target: { session: unknown },
    _ns: string,
    event: string,
    args: unknown
  ) => mocks.emitted.push({ session: target.session, event, args })
}))
vi.mock('./browser-extension-action-icon', () => ({}))
vi.mock('./browser-extension-active-tab', () => ({ grantBrowserExtensionActiveTab: mocks.grant }))
vi.mock('./browser-extension-action-registry', () => ({
  getBrowserExtensionActionState: () => ({ get: () => ({ enabled: true, popup: '' }) })
}))
vi.mock('./browser-extension-action-state', () => ({}))
vi.mock('./browser-extension-install-store', () => ({}))
vi.mock('./browser-extension-popup-host', () => ({}))
vi.mock('./browser-extension-toolbar-pins', () => ({}))
vi.mock('./browser-extension-window-model', () => ({}))
vi.mock('./browser-extension-tab-model', () => ({
  getActiveBrowserTabId: () => mocks.state.activeTabId,
  resolveBrowserExtensionTab: (id: number) =>
    mocks.tabIds.has(id) ? { contents: mocks.contents.get(id) } : null,
  describeBrowserExtensionTab: (_extension: unknown, entry: { contents: FakeContents }) => ({
    id: entry.contents.id
  })
}))

const { runBrowserExtensionToolbarAction } = await import('./browser-extension-toolbar')

const profileA = { name: 'a' }
const profileB = { name: 'b' }
const extension = { id: 'e'.repeat(32) }

function contents(id: number, session: FakeSession, isTab: boolean): FakeContents {
  const entry = { id, session, isDestroyed: () => false }
  mocks.contents.set(id, entry)
  if (isTab) {
    mocks.tabIds.add(id)
  }
  return entry
}

function run(invoking: FakeContents) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action reads only id and session of these stubs.
  const contents = invoking as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action reads only the extension's id.
  return runBrowserExtensionToolbarAction(contents, extension as Electron.Extension)
}

beforeEach(() => {
  mocks.contents.clear()
  mocks.tabIds.clear()
  mocks.grant.mockClear()
  mocks.emitted.length = 0
  // Orca's main window shows profile B's tab.
  contents(22, profileB, true)
  mocks.state.activeTabId = 22
})

describe('an extension action run from a keyboard shortcut', () => {
  it("acts on the tab the key was pressed in, not another profile's active tab", async () => {
    await run(contents(31, profileA, true))
    expect(mocks.grant).toHaveBeenCalledWith(extension, 31)
    expect(mocks.emitted).toEqual([
      { session: profileA, event: 'onClicked', args: [{ id: 31 }] },
      { session: profileA, event: 'onClicked', args: [{ id: 31 }] }
    ])
  })

  it("from a page that is no tab, uses the active tab only when it is in the caller's profile", async () => {
    const popup = contents(40, profileA, false)
    await run(popup)
    expect(mocks.grant).not.toHaveBeenCalled()
    expect(mocks.emitted).toEqual([])

    contents(21, profileA, true)
    mocks.state.activeTabId = 21
    await run(popup)
    expect(mocks.grant).toHaveBeenCalledWith(extension, 21)
    expect(mocks.emitted.map((entry) => entry.args)).toEqual([[{ id: 21 }], [{ id: 21 }]])
  })
})
