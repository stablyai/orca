import { afterEach, expect, it, vi } from 'vitest'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import {
  createRuntimeBrowserCommands,
  runtimeBrowserCommandsFactoryIsAvailable,
  runtimeBrowserCommandsFactorySupportsClientHosting,
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from '../runtime/runtime-browser-page-registry'

vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  setRuntimeBrowserCommandsFactory(null)
  setRuntimeBrowserUnavailableCause(null)
})

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'desktop-a',
  browserHostGeneration: 2,
  pageHostGeneration: 5
}

async function startWithoutEngine() {
  vi.mocked(resolveOrcadBrowserProvider).mockImplementationOnce(async () => {
    setRuntimeBrowserUnavailableCause({ reason: 'unconfigured' })
    return null
  })
  const startup = startOrcadBrowserProvider({ userDataPath: '/private-fixture' })
  await startup.ready
  return startup
}

function pairedHost(options: { desktopAttached: boolean }) {
  const pages = new RuntimeBrowserPageRegistry()
  const select = vi.fn(() => {
    if (!options.desktopAttached) {
      throw new Error('browser_host_unavailable')
    }
    return { browserHostClientId: 'desktop-a', pairedDeviceId: 'device-a' }
  })
  const createClientPage = vi.fn(async () => PLACEMENT)
  const issueClientPageCommand = vi.fn(() => ({
    result: Promise.resolve({ status: 'completed' as const })
  }))
  const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
  const host = {
    getAgentBrowserBridge: () => null,
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserNetworkExecutionHost: async () => ({
      kind: 'native' as const,
      runtimeId: 'orcad-a',
      revision: 1
    }),
    getRuntimeBrowserPageRegistry: () => pages,
    getBrowserHostLeaseRegistry: () => ({
      authorityRuntimeId: 'orcad-a',
      authorityEpoch: 'epoch-a',
      select,
      createClientPage,
      issueClientPageCommand,
      getPlacement: () => undefined
    }),
    markHeadlessBrowserSessionTabActive: vi.fn(),
    notifyHeadlessBrowserSessionTabsChanged
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every member the client-page path reads; the rest of the host is engine-only.
  const commandHost = host as unknown as RuntimeBrowserCommandHost
  return { host: commandHost, pages, select, createClientPage, issueClientPageCommand }
}

it('opens open-url in the paired desktop when orcad has no browser engine', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)

  const opened = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/',
    worktree: 'id:wt-1'
  })

  expect(paired.select).toHaveBeenCalledWith(undefined, ['webview', 'automation-v1'])
  expect(paired.createClientPage).toHaveBeenCalledWith(
    expect.objectContaining({
      browserPageId: opened.browserPageId,
      browserHostClientId: 'desktop-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      workspaceId: 'wt-1'
    })
  )
  expect(paired.issueClientPageCommand).toHaveBeenCalledWith(
    expect.objectContaining({ browserPageId: opened.browserPageId }),
    { type: 'navigate', url: 'https://example.org/' }
  )
  expect(paired.pages.getPage(opened.browserPageId)).toMatchObject({
    workspaceId: 'wt-1',
    url: 'https://example.org/',
    active: true,
    placement: PLACEMENT
  })
  await startup.stop()
})

it('refuses open-url with what to do when no paired desktop hosts this server’s pages', async () => {
  const startup = await startWithoutEngine()
  const commands = createRuntimeBrowserCommands(pairedHost({ desktopAttached: false }).host)

  await expect(
    commands.browserOpenUrlOnClient({ url: 'https://example.org/', worktree: 'id:wt-1' })
  ).rejects.toMatchObject({
    code: 'browser_host_unavailable',
    message: expect.stringContaining("open a browser tab in one of this server's workspaces")
  })
  await startup.stop()
})

it('creates a client-placed tab without an engine, and only in the default profile', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const placement = { kind: 'client' as const, browserHostClientId: 'desktop-a' }

  await expect(
    commands.browserTabCreate(
      { worktree: 'id:wt-1', page: 'page-a', url: 'https://example.org/', placement },
      { pairedDeviceId: 'device-a', clientKind: 'runtime' }
    )
  ).resolves.toEqual({ browserPageId: 'page-a' })
  expect(paired.pages.getPage('page-a')?.workspaceId).toBe('wt-1')

  await expect(
    commands.browserTabCreate(
      { worktree: 'id:wt-1', profileId: 'work', placement },
      { pairedDeviceId: 'device-a', clientKind: 'runtime' }
    )
  ).rejects.toMatchObject({ code: 'invalid_argument' })
  await startup.stop()
})

it('sends the CLI’s unplaced tab to the paired desktop, and refuses as before when none is attached', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const created = await commands.browserTabCreate({
    worktree: 'id:wt-1',
    url: 'https://example.org/'
  })
  expect(paired.pages.getPage(created.browserPageId)?.placement).toEqual(PLACEMENT)
  expect(() =>
    commands.browserTabCreate({ worktree: 'id:wt-1' }, { pairedDeviceId: 'device-a' })
  ).toThrow(/unavailable/)

  const unattached = createRuntimeBrowserCommands(pairedHost({ desktopAttached: false }).host)
  expect(() => unattached.browserTabCreate({ worktree: 'id:wt-1' })).toThrow(/unavailable/)
  await startup.stop()
})

it('lists, shows and switches desktop-hosted tabs with no engine', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const first = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/a',
    worktree: 'id:wt-1'
  })
  const second = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/b',
    worktree: 'id:wt-1'
  })

  const listed = await commands.browserTabList({ worktree: 'id:wt-1' })
  expect(listed.tabs.map((tab) => [tab.browserPageId, tab.url, tab.profileId])).toEqual([
    [first.browserPageId, 'https://example.org/a', 'default'],
    [second.browserPageId, 'https://example.org/b', 'default']
  ])
  await expect(commands.browserTabSwitch({ page: first.browserPageId })).resolves.toEqual({
    switched: 0,
    browserPageId: first.browserPageId
  })
  await expect(commands.browserTabCurrent({ worktree: 'id:wt-1' })).resolves.toMatchObject({
    tab: { browserPageId: first.browserPageId }
  })
  await expect(commands.browserTabCurrent({})).rejects.toMatchObject({ code: 'browser_no_tab' })
  await expect(commands.browserTabShow({ page: second.browserPageId })).resolves.toMatchObject({
    tab: { url: 'https://example.org/b' }
  })
  await commands.browserTabClose({ worktree: 'id:wt-1' })
  expect(paired.pages.getPage(first.browserPageId)).toBeUndefined()
  await expect(commands.browserTabCurrent({ worktree: 'id:wt-1' })).rejects.toMatchObject({
    code: 'browser_no_tab'
  })
  await startup.stop()
})

it('still refuses tab queries when neither an engine nor a desktop can serve them', async () => {
  const startup = await startWithoutEngine()
  const commands = createRuntimeBrowserCommands(pairedHost({ desktopAttached: false }).host)
  expect(() => commands.browserTabList({})).toThrow(/unavailable/)
  await startup.stop()
})

it('advertises client hosting with no engine and keeps the engine’s own cause', async () => {
  const startup = await startWithoutEngine()

  expect(runtimeBrowserCommandsFactoryIsAvailable()).toBe(false)
  expect(runtimeBrowserCommandsFactorySupportsClientHosting()).toBe(true)
  expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'unconfigured' })
  await startup.stop()
})

async function startWithEngine() {
  const engineTab = { browserPageId: 'engine-page', index: 0, url: '', title: '', active: true }
  const engine = {
    browserTabList: vi.fn(async () => ({ tabs: [engineTab] })),
    browserTabCurrent: vi.fn(async () => ({ tab: engineTab })),
    browserTabCreate: vi.fn(async () => ({ browserPageId: 'engine-page' })),
    browserTabSwitch: vi.fn(async () => ({ switched: 0, browserPageId: 'engine-page' })),
    browserTabClose: vi.fn(async () => ({ closed: true }))
  }
  vi.mocked(resolveOrcadBrowserProvider).mockResolvedValueOnce({
    kind: 'chromium',
    factory: () => Object.assign(Object.create(null), engine),
    isAvailable: () => true,
    stop: async () => {}
  })
  const startup = startOrcadBrowserProvider({ userDataPath: '/private-fixture' })
  await startup.ready
  return { startup, engine }
}

it('closes the current desktop-hosted page itself instead of the engine’s current tab', async () => {
  const { startup, engine } = await startWithEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const opened = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/',
    worktree: 'id:wt-1'
  })

  await expect(commands.browserTabClose({ worktree: 'id:wt-1' })).resolves.toEqual({ closed: true })
  expect(paired.pages.getPage(opened.browserPageId)).toBeUndefined()
  expect(engine.browserTabClose).not.toHaveBeenCalled()
  await commands.browserTabClose({ worktree: 'id:wt-1' })
  expect(engine.browserTabClose).toHaveBeenCalledWith({ worktree: 'id:wt-1' })
  await startup.stop()
})

it('lists desktop-hosted pages after the engine’s tabs, as automation would pick them', async () => {
  const { startup } = await startWithEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const opened = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/',
    worktree: 'id:wt-1'
  })

  const listed = await commands.browserTabList({ worktree: 'id:wt-1' })
  expect(listed.tabs.map((tab) => [tab.browserPageId, tab.index, tab.active])).toEqual([
    ['engine-page', 0, false],
    [opened.browserPageId, 1, true]
  ])
  await expect(commands.browserTabShow({ page: opened.browserPageId })).resolves.toMatchObject({
    tab: { browserPageId: opened.browserPageId, index: 1 }
  })
  await startup.stop()
})

it('keeps the engine’s own per-workspace current tab where no desktop page is selected', async () => {
  const { startup, engine } = await startWithEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  await commands.browserOpenUrlOnClient({ url: 'https://example.org/', worktree: 'id:wt-c' })

  await expect(commands.browserTabCurrent({ worktree: 'id:wt-a' })).resolves.toMatchObject({
    tab: { browserPageId: 'engine-page' }
  })
  expect(engine.browserTabCurrent).toHaveBeenCalledWith({ worktree: 'id:wt-a' })
  await startup.stop()
})

it('hands workspace commands back to the engine once it creates or selects a tab', async () => {
  const { startup, engine } = await startWithEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  const isActive = (browserPageId: string): boolean | undefined =>
    paired.pages.getPage(browserPageId)?.active
  const opened = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/',
    worktree: 'id:wt-1'
  })

  await commands.browserTabCreate({ worktree: 'id:wt-1', url: 'https://engine.test/' })
  expect(engine.browserTabCreate).toHaveBeenCalled()
  expect(isActive(opened.browserPageId)).toBe(false)

  await commands.browserTabSwitch({ page: opened.browserPageId, worktree: 'id:wt-1' })
  expect(isActive(opened.browserPageId)).toBe(true)
  await expect(commands.browserTabSwitch({ page: 'engine-page' })).resolves.toMatchObject({
    browserPageId: 'engine-page'
  })
  expect(engine.browserTabSwitch).toHaveBeenCalledWith({ page: 'engine-page' })
  expect(isActive(opened.browserPageId)).toBe(false)
  await startup.stop()
})

it('closes a desktop-hosted page by index with no engine', async () => {
  const startup = await startWithoutEngine()
  const paired = pairedHost({ desktopAttached: true })
  const commands = createRuntimeBrowserCommands(paired.host)
  await commands.browserOpenUrlOnClient({ url: 'https://example.org/a', worktree: 'id:wt-1' })
  const second = await commands.browserOpenUrlOnClient({
    url: 'https://example.org/b',
    worktree: 'id:wt-1'
  })

  await expect(commands.browserTabClose({ index: 1, worktree: 'id:wt-1' })).resolves.toEqual({
    closed: true
  })
  expect(paired.pages.getPage(second.browserPageId)).toBeUndefined()
  expect(paired.pages.listPages('wt-1')).toHaveLength(1)
  await startup.stop()
})
