import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  readDockCompletedConversations,
  DOCK_CONVERSATIONS_UPDATE,
  DOCK_CONVERSATION_OPEN
} from '../../shared/dock-completed-conversations'

const mocks = vi.hoisted(() => ({
  setMenu: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  reveal: vi.fn(),
  trusted: vi.fn(),
  window: vi.fn(),
  onLanguage: vi.fn(),
  offLanguage: vi.fn(),
  quit: vi.fn()
}))
vi.mock('electron', () => ({
  app: { dock: { setMenu: mocks.setMenu }, once: mocks.quit, removeListener: vi.fn() },
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template }
}))
vi.mock('../ipc/ui', () => ({
  getTrustedUIRendererWebContents: mocks.trusted,
  getTrustedUIRendererWindow: mocks.window
}))
vi.mock('../window/focus-existing-window', () => ({ safelyRevealWindow: mocks.reveal }))
vi.mock('../i18n/main-i18n', () => ({
  mainI18n: { on: mocks.onLanguage, off: mocks.offLanguage },
  translateMain: (_key: string, fallback: string) => fallback
}))

import {
  buildCompletedConversationsMenu,
  registerCompletedConversationsMenu
} from './completed-conversations-menu'

describe('completed conversations Dock menu', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })
  afterEach(() => Object.defineProperty(process, 'platform', platform))

  it('keeps every conversation reachable beyond the Activity history cap', () => {
    const entries = Array.from({ length: 105 }, (_, n) => ({ id: String(n), label: `Task ${n}` }))
    const open = vi.fn()
    const menu = buildCompletedConversationsMenu(entries, open)
    const labels: string[] = []
    for (const group of menu.slice(1)) {
      if (Array.isArray(group.submenu)) {
        labels.push(...group.submenu.map((item) => item.label ?? ''))
      }
    }
    expect(labels).toEqual(entries.map((entry) => entry.label))
    expect(open).not.toHaveBeenCalled()
    expect(menu[0]).toMatchObject({ label: 'Completed, unread (105)', enabled: false })
  })

  it('uses a disabled empty state and rejects invalid or duplicated entries', () => {
    expect(buildCompletedConversationsMenu([], vi.fn())).toEqual([
      { label: 'No completed conversations to read', enabled: false }
    ])
    for (const input of [
      null,
      [{ id: 'x', label: 2 }],
      [
        { id: 'x', label: 'a' },
        { id: 'x', label: 'b' }
      ],
      Array.from({ length: 201 }, (_, index) => ({ id: String(index), label: 'a' }))
    ]) {
      expect(() => readDockCompletedConversations(input)).toThrow()
    }
  })

  it.each(['win32', 'linux'])('does not register or call Dock on %s', (value) => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
    registerCompletedConversationsMenu()
    expect(mocks.handle).not.toHaveBeenCalled()
    expect(mocks.setMenu).not.toHaveBeenCalled()
  })

  it('only accepts the main renderer, updates without focusing and clears on reload', () => {
    const renderer = Object.assign(new EventEmitter(), { send: vi.fn() })
    const window = { isDestroyed: () => false, webContents: renderer }
    mocks.trusted.mockReturnValue(renderer)
    mocks.window.mockReturnValue(window)
    registerCompletedConversationsMenu()
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === DOCK_CONVERSATIONS_UPDATE
    )?.[1]
    expect(handler).toBeTypeOf('function')
    handler({ sender: {} }, [{ id: 'wrong', label: 'Wrong' }])
    expect(mocks.setMenu).toHaveBeenCalledTimes(1)
    handler({ sender: renderer }, [{ id: 'one', label: 'One' }])
    const menu = mocks.setMenu.mock.lastCall?.[0]
    expect(mocks.reveal).not.toHaveBeenCalled()
    const rebuilds = mocks.setMenu.mock.calls.length
    handler({ sender: renderer }, [{ id: 'one', label: 'One' }])
    expect(mocks.setMenu).toHaveBeenCalledTimes(rebuilds)
    menu[1].click()
    expect(renderer.send).toHaveBeenCalledWith(DOCK_CONVERSATION_OPEN, 'one')
    expect(mocks.reveal).toHaveBeenCalledWith(window)
    renderer.send.mockClear()
    renderer.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(mocks.setMenu).toHaveBeenCalledTimes(rebuilds)
    renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    menu[1].click()
    expect(renderer.send).not.toHaveBeenCalled()
    expect(renderer.listenerCount('destroyed')).toBe(0)
    expect(mocks.setMenu.mock.lastCall?.[0][0].enabled).toBe(false)
  })
})
