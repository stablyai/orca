import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_AGENT_MENU_PAGE_SIZE } from '../../shared/dock-agent-menu'

const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const createEmitter = () => new EventEmitter()
  const app = createEmitter()
  const trustedRenderer = Object.assign(createEmitter(), { mainFrame: {} })
  const setMenu = vi.fn()
  const buildFromTemplate = vi.fn((template: unknown) => ({ template }))
  const handlerState: { current: ((event: unknown, value: unknown) => void) | null } = {
    current: null
  }
  const trustedWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() }
  }
  Object.assign(app, { dock: { setMenu } })
  return {
    app,
    trustedRenderer,
    createEmitter,
    trustedWindow,
    setMenu,
    buildFromTemplate,
    handlerState,
    removeHandler: vi.fn(),
    getTrustedUIRendererWebContents: vi.fn(() => trustedRenderer),
    getTrustedUIRendererWindow: vi.fn(() => trustedWindow),
    safelyRevealWindow: vi.fn(),
    mainI18n: createEmitter()
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  ipcMain: {
    handle: vi.fn((_channel: string, handler: (event: unknown, value: unknown) => void) => {
      mocks.handlerState.current = handler
    }),
    removeHandler: mocks.removeHandler
  },
  Menu: { buildFromTemplate: mocks.buildFromTemplate }
}))

vi.mock('../ipc/ui', () => ({
  getTrustedUIRendererWebContents: mocks.getTrustedUIRendererWebContents,
  getTrustedUIRendererWindow: mocks.getTrustedUIRendererWindow
}))

vi.mock('../window/focus-existing-window', () => ({ safelyRevealWindow: mocks.safelyRevealWindow }))

vi.mock('../i18n/main-i18n', () => ({
  mainI18n: mocks.mainI18n,
  translateMain: (_key: string, fallback: string) => fallback
}))

import { buildDockAgentMenu, registerDockAgentMenu } from './agent-menu'

function entry(id: string) {
  return {
    id,
    label: `Agent ${id}`,
    target: {
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      executionHostId: 'local' as const,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    }
  }
}

function lastMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const menu = mocks.setMenu.mock.lastCall?.[0]
  if (!menu || typeof menu !== 'object' || !('template' in menu)) {
    throw new Error('Dock menu was not built')
  }
  return menu.template
}

function trustedEvent() {
  return { sender: mocks.trustedRenderer, senderFrame: mocks.trustedRenderer.mainFrame }
}

function reachableAgentItems(
  template: Electron.MenuItemConstructorOptions[]
): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = []
  for (const item of template) {
    if (Array.isArray(item.submenu)) {
      expect(item.submenu.length).toBeLessThanOrEqual(DOCK_AGENT_MENU_PAGE_SIZE)
      items.push(...reachableAgentItems(item.submenu))
    } else if (item.click) {
      items.push(item)
    }
  }
  return items
}

describe('Dock agent menu', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mocks.setMenu.mockReset()
    mocks.buildFromTemplate.mockClear()
    mocks.removeHandler.mockReset()
    mocks.handlerState.current = null
    mocks.trustedRenderer.removeAllListeners()
    mocks.trustedWindow.isDestroyed.mockReturnValue(false)
    mocks.trustedWindow.webContents.send.mockReset()
    mocks.getTrustedUIRendererWebContents.mockClear()
    mocks.getTrustedUIRendererWindow.mockClear()
    mocks.safelyRevealWindow.mockReset()
  })

  afterEach(() => {
    mocks.app.emit('will-quit')
    vi.restoreAllMocks()
  })

  it('builds active and unread sections with disabled empty states', () => {
    const template = buildDockAgentMenu({ active: [entry('active')], unread: [] }, vi.fn())
    expect(template.map((item) => item.label)).toEqual([
      'Active agents (1)',
      'Agent active',
      undefined,
      'Unread messages (0)',
      'No unread messages'
    ])
    expect(template[0]?.enabled).toBe(false)
    expect(template[4]?.enabled).toBe(false)
  })

  it('renders only on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    registerDockAgentMenu()
    expect(mocks.setMenu).not.toHaveBeenCalled()
    expect(mocks.handlerState.current).toBeNull()
  })

  it('keeps every conversation reachable through bounded range submenus', () => {
    const entries = Array.from({ length: 421 }, (_, index) => entry(String(index)))
    const open = vi.fn()
    const template = buildDockAgentMenu({ active: [], unread: entries }, open)
    const items = reachableAgentItems(template)

    expect(template).toContainEqual(expect.objectContaining({ label: 'Unread messages (421)' }))
    expect(template).toContainEqual(expect.objectContaining({ label: '401–421' }))
    expect(items.map((item) => item.label)).toEqual(entries.map((candidate) => candidate.label))
    expect(open).not.toHaveBeenCalled()
    const lastClick = items.at(-1)?.click
    if (!lastClick) {
      throw new Error('Last conversation is not clickable')
    }
    Reflect.apply(lastClick, undefined, [])
    expect(open).toHaveBeenCalledWith(entries.at(-1))
  })

  it('accepts only the trusted renderer and clears the menu after a full navigation', () => {
    registerDockAgentMenu()
    const handler = mocks.handlerState.current
    expect(handler).not.toBeNull()

    handler?.({ sender: mocks.createEmitter() }, { active: [entry('untrusted')], unread: [] })
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )

    handler?.(
      { sender: mocks.trustedRenderer, senderFrame: {} },
      { active: [entry('subframe')], unread: [] }
    )
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )

    handler?.(trustedEvent(), { active: [entry('trusted')], unread: [] })
    expect(lastMenuTemplate()).toContainEqual(expect.objectContaining({ label: 'Agent trusted' }))

    mocks.trustedRenderer.emit('did-navigate', {}, 'file:///app', 200, 'OK')
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )
  })

  it('preserves the menu when navigation is blocked or stays within the document', () => {
    registerDockAgentMenu()
    mocks.handlerState.current?.(trustedEvent(), { active: [entry('active')], unread: [] })
    const renders = mocks.setMenu.mock.calls.length

    for (const url of ['https://example.invalid/', 'file:///Users/me/dropped.png']) {
      mocks.trustedRenderer.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url
      })
      mocks.trustedRenderer.emit('will-navigate', { defaultPrevented: true }, url)
    }
    mocks.trustedRenderer.emit('did-navigate-in-page', {}, 'file:///app#pane', true)

    expect(mocks.setMenu).toHaveBeenCalledTimes(renders)
    expect(lastMenuTemplate()).toContainEqual(expect.objectContaining({ label: 'Agent active' }))
  })

  it.each(['render-process-gone', 'destroyed'])('clears entries after %s', (event) => {
    registerDockAgentMenu()
    mocks.handlerState.current?.(trustedEvent(), { active: [entry('active')], unread: [] })
    mocks.trustedRenderer.emit(event)
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )
  })

  it('reveals the main window and forwards the exact target on selection', () => {
    registerDockAgentMenu()
    mocks.handlerState.current?.(trustedEvent(), { active: [entry('active')], unread: [] })

    const item = lastMenuTemplate().find((candidate) => candidate.label === 'Agent active')
    const click = item?.click
    expect(click).toBeTypeOf('function')
    if (typeof click !== 'function') {
      throw new Error('Dock agent menu item is not clickable')
    }
    Reflect.apply(click, undefined, [])

    expect(mocks.safelyRevealWindow).toHaveBeenCalledWith(mocks.trustedWindow)
    expect(mocks.trustedWindow.webContents.send).toHaveBeenCalledWith(
      'app:openDockAgent',
      entry('active').target
    )
  })

  it('preserves the last valid menu when shared ids have conflicting targets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerDockAgentMenu()
    const payload = { active: [entry('same')], unread: [entry('same')] }
    mocks.handlerState.current?.(trustedEvent(), payload)
    const renders = mocks.setMenu.mock.calls.length

    mocks.handlerState.current?.(trustedEvent(), {
      active: payload.active,
      unread: [{ ...entry('same'), target: { ...entry('same').target, tabId: 'other-tab' } }]
    })
    expect(warn).toHaveBeenCalledWith(
      '[dock] rejected malformed agent menu:',
      'Conflicting Dock agent targets'
    )
    expect(mocks.setMenu).toHaveBeenCalledTimes(renders)

    const unreadClick = lastMenuTemplate().at(-1)?.click
    if (!unreadClick) {
      throw new Error('Unread Dock agent menu item is not clickable')
    }
    Reflect.apply(unreadClick, undefined, [])
    expect(mocks.trustedWindow.webContents.send).toHaveBeenLastCalledWith(
      'app:openDockAgent',
      entry('same').target
    )
  })

  it('resolves an older menu click to the latest target and rejects removed entries', () => {
    registerDockAgentMenu()
    mocks.handlerState.current?.(trustedEvent(), { active: [entry('active')], unread: [] })
    const click = lastMenuTemplate().find((candidate) => candidate.label === 'Agent active')?.click
    if (!click) {
      throw new Error('Dock agent menu item is not clickable')
    }
    const latest = {
      ...entry('active'),
      target: { ...entry('active').target, tabId: 'resumed-tab', leafId: 'resumed-leaf' }
    }
    mocks.handlerState.current?.(trustedEvent(), { active: [], unread: [latest] })
    Reflect.apply(click, undefined, [])
    expect(mocks.trustedWindow.webContents.send).toHaveBeenLastCalledWith(
      'app:openDockAgent',
      latest.target
    )

    mocks.handlerState.current?.(trustedEvent(), { active: [], unread: [] })
    Reflect.apply(click, undefined, [])
    expect(mocks.trustedWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(mocks.safelyRevealWindow).toHaveBeenCalledTimes(1)
  })
})
