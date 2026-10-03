import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const createEmitter = () => {
    const listeners = new Map<string, Set<Listener>>()
    return {
      on(event: string, listener: Listener) {
        const group = listeners.get(event) ?? new Set<Listener>()
        group.add(listener)
        listeners.set(event, group)
        return this
      },
      once(event: string, listener: Listener) {
        const wrapped: Listener = (...args) => {
          this.removeListener(event, wrapped)
          listener(...args)
        }
        return this.on(event, wrapped)
      },
      removeListener(event: string, listener: Listener) {
        listeners.get(event)?.delete(listener)
        return this
      },
      off(event: string, listener: Listener) {
        return this.removeListener(event, listener)
      },
      removeAllListeners() {
        listeners.clear()
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args)
        }
        return listeners.has(event)
      }
    }
  }
  const app = createEmitter()
  const trustedRenderer = createEmitter()
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

  it('accepts only the trusted renderer and clears the menu after a full navigation', () => {
    registerDockAgentMenu()
    const handler = mocks.handlerState.current
    expect(handler).not.toBeNull()

    handler?.({ sender: mocks.createEmitter() }, { active: [entry('untrusted')], unread: [] })
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )

    handler?.({ sender: mocks.trustedRenderer }, { active: [entry('trusted')], unread: [] })
    expect(lastMenuTemplate()).toContainEqual(expect.objectContaining({ label: 'Agent trusted' }))

    mocks.trustedRenderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(lastMenuTemplate()).toContainEqual(
      expect.objectContaining({ label: 'No active agents' })
    )
  })

  it('reveals the main window and forwards the exact target on selection', () => {
    registerDockAgentMenu()
    mocks.handlerState.current?.(
      { sender: mocks.trustedRenderer },
      { active: [entry('active')], unread: [] }
    )

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
})
