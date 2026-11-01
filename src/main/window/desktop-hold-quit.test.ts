import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { HoldQuitWatchEvent } from './hold-quit-gesture'
import type { KeybindingOverrides } from '../../shared/keybindings'
import { registerNativePopupQuitSurface } from '../browser/native-browser-popup-windows'

const mocks = vi.hoisted(() => {
  const watches: { emit: (event: HoldQuitWatchEvent) => void; cancel: ReturnType<typeof vi.fn> }[] =
    []
  return { watches, injected: false }
})
class Contents extends EventEmitter {
  hostWebContents: Contents | undefined
  devToolsWebContents: Contents | undefined
  destroyed = false
  focused = true
  send = vi.fn()
  constructor(readonly id: number) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  isFocused() {
    return this.focused
  }
}
const ipc = new EventEmitter()
const app = new EventEmitter()
const main = new Contents(1)
const guest = new Contents(2)
guest.hostWebContents = main
const popout = new Contents(3)
const allContents = [main, guest, popout]
const mainWindow = Object.assign(new EventEmitter(), {
  destroyed: false,
  focused: true,
  isFocused: () => mainWindow.focused,
  isDestroyed: () => mainWindow.destroyed,
  webContents: main
})
const popoutWindow = Object.assign(new EventEmitter(), {
  destroyed: false,
  focused: true,
  isFocused: () => popoutWindow.focused,
  isDestroyed: () => popoutWindow.destroyed,
  webContents: popout
})
const popupWindow = Object.assign(new EventEmitter(), {
  destroyed: false,
  focused: true,
  isFocused: () => popupWindow.focused,
  isDestroyed: () => popupWindow.destroyed
})
const popupNotice = vi.fn()
const windowOwners = new Map([
  [main, mainWindow],
  [popout, popoutWindow]
])
vi.mock('electron', () => ({
  app,
  ipcMain: ipc,
  webContents: { getAllWebContents: () => allContents },
  BrowserWindow: {
    fromWebContents: (contents: Contents) => windowOwners.get(contents) ?? null
  }
}))
vi.mock('../browser/agent-input-injection', () => ({ isAgentInjectingInput: () => mocks.injected }))
vi.mock('./macos-quit-chord-watch', () => ({
  watchMacQuitChord: (_code: string, emit: (event: HoldQuitWatchEvent) => void) => {
    const cancel = vi.fn()
    mocks.watches.push({ emit, cancel })
    return cancel
  }
}))
const { installDesktopHoldQuit } = await import('./desktop-hold-quit')
const { webContents, BrowserWindow } = await import('electron')
const { createAppMenuQuitItem } = await import('../menu/app-menu-quit-item')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
beforeEach(() => {
  allContents.splice(0, allContents.length, main, guest, popout)
  windowOwners.clear()
  windowOwners.set(main, mainWindow)
  windowOwners.set(popout, popoutWindow)
  for (const contents of allContents) {
    contents.destroyed = false
    contents.focused = true
    contents.devToolsWebContents = undefined
  }
  for (const window of [mainWindow, popoutWindow, popupWindow]) {
    window.destroyed = false
    window.focused = true
  }
})
afterEach(() => {
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
  for (const emitter of [ipc, app, main, guest, popout, mainWindow, popoutWindow, popupWindow]) {
    emitter.removeAllListeners()
  }
  mocks.watches = []
  mocks.injected = false
  main.send.mockClear()
  popout.send.mockClear()
  popupNotice.mockClear()
  vi.restoreAllMocks()
})

it('guards BaseWindow popup contents and delivers native-ack progress only to its trusted notice owner', () => {
  const f = fixture()
  const popupContents = new Contents(5)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed WebContents methods.
  const unregister = registerNativePopupQuitSurface(popupContents as never, {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed BaseWindow lifecycle.
    window: popupWindow as never,
    notice: popupNotice
  })
  app.emit('web-contents-created', {}, popupContents)
  ipc.emit('ui:holdQuitActivity', { sender: popupContents }, true)
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  ipc.emit('ui:holdQuitActivity', { sender: popupContents }, false)
  key(popupContents)
  expect(popupNotice).toHaveBeenLastCalledWith({ phase: 'starting' })
  mocks.watches[0]?.emit('watching')
  expect(popupNotice).toHaveBeenLastCalledWith({ phase: 'holding' })
  key(popupContents, 'keyUp')
  expect(popupNotice).toHaveBeenLastCalledWith({ phase: 'released' })
  mocks.watches[0]?.emit('held')
  key(popupContents)
  popupWindow.emit('blur')
  mocks.watches[1]?.emit('held')
  expect(f.quit).not.toHaveBeenCalled()
  key(popupContents)
  mocks.watches[2]?.emit('watching')
  popupContents.destroyed = true
  unregister()
  popupContents.emit('destroyed')
  expect(popupNotice).toHaveBeenLastCalledWith({ phase: 'dismissed' })
  expect(mocks.watches[2]?.cancel).toHaveBeenCalledOnce()
  f.dispose()
})

function fixture(platform = 'darwin') {
  Object.defineProperty(process, 'platform', { value: platform })
  let bindings: KeybindingOverrides | undefined
  let localBusy = false
  let settings = { ...getDefaultSettings('/tmp'), holdQuitWhileAgentsWork: true }
  let changed: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void = () => {}
  const quit = vi.fn()
  const getKeybindings = vi.fn(() => bindings)
  const buildQuitItem = () =>
    createAppMenuQuitItem(undefined, 'Orca', {
      isEnabled: () => settings.holdQuitWhileAgentsWork,
      quit
    })
  let quitItem = buildQuitItem()
  const rebuildMenu = vi.fn(() => {
    quitItem = buildQuitItem()
  })
  const dispose = installDesktopHoldQuit({
    store: {
      getSettings: () => settings,
      onSettingsChanged: (listener) => {
        changed = listener
        return () => {}
      }
    },
    isActivityOwner: (sender) => sender.id === main.id,
    isUIRenderer: (sender) => sender.id === main.id || sender.id === popout.id,
    isLocalWorkActive: () => localBusy,
    getKeybindings,
    quit,
    rebuildMenu
  })
  return {
    quit,
    getKeybindings,
    dispose,
    rebuildMenu,
    menu: () => quitItem,
    workLocally: () => {
      localBusy = true
    },
    bindQ: () => {
      bindings = { 'app.settings': ['Cmd+Q'] }
    },
    disable: () => {
      settings = { ...settings, holdQuitWhileAgentsWork: false }
      changed({ holdQuitWhileAgentsWork: false }, settings)
    }
  }
}

it.each(['keyDown', 'keyUp', 'rawKeyDown'])(
  'keeps ordinary %s off the ownership and shortcut-check path',
  (type) => {
    const tools = new Contents(16)
    guest.devToolsWebContents = tools
    allContents.push(tools)
    const f = fixture()
    const enumerate = vi.spyOn(webContents, 'getAllWebContents')
    const owner = vi.spyOn(BrowserWindow, 'fromWebContents')
    const focus = vi.spyOn(mainWindow, 'isFocused')
    try {
      for (const contents of [main, guest, popout, tools]) {
        for (const input of [
          { key: 'a', code: 'KeyA', meta: false },
          { key: 'a', code: 'KeyA', meta: true },
          { key: 'q', code: 'KeyQ', meta: false },
          { key: 'q', code: 'KeyQ', meta: true, shift: true }
        ]) {
          const event = { preventDefault: vi.fn() }
          if (type === 'rawKeyDown') {
            contents.emit('input-event', event, {
              ...input,
              type,
              modifiers: [...(input.meta ? ['meta'] : []), ...('shift' in input ? ['shift'] : [])]
            })
          } else {
            contents.emit('before-input-event', event, { ...input, type })
          }
          expect(event.preventDefault).not.toHaveBeenCalled()
        }
      }
      expect({
        enumerations: enumerate.mock.calls.length,
        owners: owner.mock.calls.length,
        focusChecks: focus.mock.calls.length,
        keybindingReads: f.getKeybindings.mock.calls.length
      }).toEqual({ enumerations: 0, owners: 0, focusChecks: 0, keybindingReads: 0 })
      expect(mocks.watches).toHaveLength(0)
      expect(f.quit).not.toHaveBeenCalled()
    } finally {
      f.dispose()
      tools.removeAllListeners()
    }
  }
)

it.each([
  { type: 'keyDown', key: 'a', code: 'KeyA', meta: true, phase: 'dismissed' },
  { type: 'rawKeyDown', key: 'a', code: 'KeyA', meta: true, phase: 'dismissed' },
  { type: 'keyUp', key: 'q', code: 'KeyQ', meta: true, phase: 'released' },
  { type: 'keyUp', key: 'Meta', code: 'MetaLeft', meta: false, phase: 'released' }
])('forwards $type $key to cancel the active native hold', ({ phase, ...input }) => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  key(guest)
  const watch = mocks.watches[0]
  watch?.emit('watching')
  guest.emit(
    input.type === 'rawKeyDown' ? 'input-event' : 'before-input-event',
    { preventDefault: vi.fn() },
    { ...input, modifiers: ['meta'] }
  )
  expect(watch?.cancel).toHaveBeenCalledOnce()
  expect(main.send).toHaveBeenLastCalledWith('ui:holdQuitNotice', { phase })
  watch?.emit('held')
  expect(f.quit).not.toHaveBeenCalled()
  key(guest)
  mocks.watches[1]?.emit('watching')
  expect(main.send).toHaveBeenLastCalledWith('ui:holdQuitNotice', { phase: 'holding' })
  mocks.watches[1]?.emit('held')
  expect(f.quit).toHaveBeenCalledOnce()
  f.dispose()
})

it.each(['starting', 'holding'] as const)(
  'dismisses the trusted owner notice when a %s guest is destroyed',
  (phase) => {
    const f = fixture()
    try {
      ipc.emit('ui:holdQuitActivity', { sender: main }, true)
      key(guest)
      const watch = mocks.watches[0]
      if (phase === 'holding') {
        watch?.emit('watching')
      }
      expect(main.send).toHaveBeenLastCalledWith('ui:holdQuitNotice', { phase })
      guest.destroyed = true
      guest.emit('destroyed')
      expect(watch?.cancel).toHaveBeenCalledOnce()
      expect(main.send).toHaveBeenLastCalledWith('ui:holdQuitNotice', { phase: 'dismissed' })
      watch?.emit('held')
      expect(f.quit).not.toHaveBeenCalled()
      expect(popout.send).not.toHaveBeenCalled()
    } finally {
      f.dispose()
    }
  }
)

it('restores native idle CmdQ without a routable surface, including orphan contents', () => {
  allContents.splice(0)
  const orphan = new Contents(9)
  const tools = new Contents(10)
  orphan.devToolsWebContents = tools
  allContents.push(orphan, tools)
  windowOwners.set(tools, mainWindow)
  const f = fixture()
  expect(f.menu().role).toBe('quit')
  const serveQuit = vi.fn()
  const serveItem = createAppMenuQuitItem(serveQuit, 'Orca', {
    isEnabled: () => true,
    quit: f.quit
  })
  expect(serveItem.accelerator).toBe('CmdOrCtrl+Q')
  if (serveItem.click) {
    serveItem.click()
  }
  expect(serveQuit).toHaveBeenCalledOnce()
  expect(f.quit).not.toHaveBeenCalled()
  f.dispose()
})

it('refreshes native CmdQ on last-window closure and suppresses it before a reopened window loads', () => {
  const f = fixture()
  expect(f.menu().role).toBeUndefined()
  mainWindow.destroyed = true
  mainWindow.emit('closed')
  expect(f.menu().role).toBeUndefined()
  popoutWindow.destroyed = true
  popoutWindow.emit('closed')
  expect(f.menu().role).toBe('quit')
  const reopened = new Contents(11)
  allContents.push(reopened)
  app.emit('web-contents-created', {}, reopened)
  expect(f.menu().role).toBe('quit')
  const reopenedWindow = Object.assign(new EventEmitter(), {
    destroyed: false,
    focused: true,
    isFocused: () => reopenedWindow.focused,
    isDestroyed: () => reopenedWindow.destroyed,
    webContents: reopened
  })
  windowOwners.set(reopened, reopenedWindow)
  app.emit('browser-window-created', {}, reopenedWindow)
  expect(f.menu().role).toBeUndefined()
  expect(f.menu().accelerator).toBeUndefined()
  f.workLocally()
  expect(key(reopened).preventDefault).toHaveBeenCalledOnce()
  expect(f.quit).not.toHaveBeenCalled()
  f.dispose()
})

it('uses real registered BaseWindow ownership and restores native CmdQ when it closes with live contents', () => {
  allContents.splice(0)
  const f = fixture()
  const page = new Contents(12)
  const tools = new Contents(13)
  page.devToolsWebContents = tools
  allContents.push(page, tools)
  app.emit('web-contents-created', {}, page)
  app.emit('web-contents-created', {}, tools)
  expect(f.menu().role).toBe('quit')
  const surface = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed BaseWindow lifecycle.
    window: popupWindow as never,
    notice: popupNotice
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed WebContents methods.
  const unregister = registerNativePopupQuitSurface(page as never, surface)
  expect(f.menu().role).toBeUndefined()
  unregister()
  expect(f.menu().role).toBe('quit')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed WebContents methods.
  const unregisterAgain = registerNativePopupQuitSurface(page as never, surface)
  expect(f.menu().role).toBeUndefined()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  const event = { preventDefault: vi.fn() }
  tools.emit('input-event', event, {
    type: 'rawKeyDown',
    key: 'q',
    code: 'KeyQ',
    modifiers: ['meta']
  })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  popupWindow.destroyed = true
  popupWindow.emit('closed')
  expect(f.menu().role).toBe('quit')
  mocks.watches[0]?.emit('held')
  expect(f.quit).not.toHaveBeenCalled()
  unregisterAgain()
  f.dispose()
})

it('refreshes the fallback when the last routable contents is destroyed and removes lifecycle listeners', () => {
  allContents.splice(0, allContents.length, main)
  const f = fixture()
  main.destroyed = true
  main.emit('destroyed')
  expect(f.menu().role).toBe('quit')
  f.dispose()
  f.rebuildMenu.mockClear()
  app.emit('browser-window-created', {}, mainWindow)
  mainWindow.emit('closed')
  expect(f.rebuildMenu).not.toHaveBeenCalled()
})

it('keeps native CmdQ when existing windows have no focused input route', () => {
  mainWindow.focused = false
  popoutWindow.focused = false
  const f = fixture()
  expect(f.menu().role).toBe('quit')
  f.dispose()
})

it.each([
  ['blur', 'focus'],
  ['hide', 'show'],
  ['minimize', 'restore']
])('refreshes native CmdQ on %s and guards the focused window again on %s', (lost, gained) => {
  const f = fixture()
  mainWindow.focused = false
  popoutWindow.focused = false
  mainWindow.emit(lost)
  expect(f.menu().role).toBe('quit')
  mainWindow.focused = true
  mainWindow.emit(gained)
  expect(f.menu().role).toBeUndefined()
  expect(f.menu().accelerator).toBeUndefined()
  f.workLocally()
  expect(key(main).preventDefault).toHaveBeenCalledOnce()
  expect(f.quit).not.toHaveBeenCalled()
  f.dispose()
})

it.each(['desktop', 'popup'])(
  'uses focused %s DevTools while its inspected owner is unfocused',
  (kind) => {
    mainWindow.focused = false
    popoutWindow.focused = false
    popupWindow.focused = false
    const page = kind === 'desktop' ? guest : new Contents(14)
    const tools = new Contents(15)
    tools.focused = false
    page.devToolsWebContents = tools
    allContents.splice(0, allContents.length, page, tools)
    let unregister = () => {}
    if (kind === 'popup') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed WebContents methods.
      unregister = registerNativePopupQuitSurface(page as never, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the consumed BaseWindow lifecycle.
        window: popupWindow as never,
        notice: popupNotice
      })
    }
    const f = fixture()
    expect(f.menu().role).toBe('quit')
    tools.focused = true
    tools.emit('focus')
    expect(f.menu().role).toBeUndefined()
    f.workLocally()
    const event = { preventDefault: vi.fn() }
    tools.emit('input-event', event, {
      type: 'rawKeyDown',
      key: 'q',
      code: 'KeyQ',
      modifiers: ['meta']
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    tools.focused = false
    tools.emit('blur')
    expect(f.menu().role).toBe('quit')
    mocks.watches[0]?.emit('held')
    expect(f.quit).not.toHaveBeenCalled()
    unregister()
    f.dispose()
  }
)

it.each(['linux', 'win32'])('leaves %s input and lifecycle listeners untouched', (platform) => {
  const f = fixture(platform)
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  expect(key(main).preventDefault).not.toHaveBeenCalled()
  expect(mocks.watches).toHaveLength(0)
  expect(f.quit).not.toHaveBeenCalled()
  expect(app.listenerCount('before-quit')).toBe(0)
  f.dispose()
})

it('cancels on owning window blur and yields when CmdQ acquires another shortcut owner', () => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  key(main)
  mainWindow.emit('blur')
  mocks.watches[0]?.emit('held')
  key(main)
  f.bindQ()
  mocks.watches[1]?.emit('held')
  expect(key(main).preventDefault).not.toHaveBeenCalled()
  expect(mocks.watches).toHaveLength(2)
  expect(f.quit).not.toHaveBeenCalled()
  f.dispose()
})
function key(contents: Contents, type = 'keyDown', key = 'q', meta = true) {
  const event = { preventDefault: vi.fn() }
  contents.emit('before-input-event', event, {
    type,
    key,
    code: key === 'q' ? 'KeyQ' : 'MetaLeft',
    meta,
    isAutoRepeat: false
  })
  return event
}

it('routes all UI holds and consumes embedded page Q before its DOM receives it', () => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  for (const contents of [main, guest, popout]) {
    const event = key(contents)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    const watch = mocks.watches.at(-1)
    key(contents, 'keyUp')
    expect(watch?.cancel).toHaveBeenCalledOnce()
    watch?.emit('held')
  }
  expect(f.quit).not.toHaveBeenCalled()
  expect(main.send).toHaveBeenCalledWith('ui:holdQuitNotice', { phase: 'starting' })
  expect(popout.send).toHaveBeenCalledWith('ui:holdQuitNotice', { phase: 'starting' })
  f.dispose()
})

it('clears recorder ownership and pending work on renderer loss or navigation', () => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  for (const reason of ['render-process-gone', 'did-start-navigation']) {
    ipc.emit('ui:setShortcutRecorderFocused', { sender: main }, true)
    main.emit(reason, {}, 'about:blank', false, true)
    ipc.emit('ui:holdQuitActivity', { sender: main }, true)
    key(main)
  }
  expect(mocks.watches).toHaveLength(2)
  f.dispose()
})

it('routes guest DevTools raw input through its existing input-event lane to the owning UI', () => {
  const f = fixture()
  const tools = new Contents(4)
  guest.devToolsWebContents = tools
  app.emit('web-contents-created', {}, tools)
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  const event = { preventDefault: vi.fn() }
  tools.emit('input-event', event, {
    type: 'rawKeyDown',
    key: 'q',
    code: 'KeyQ',
    modifiers: ['meta']
  })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(main.send).toHaveBeenCalledWith('ui:holdQuitNotice', { phase: 'starting' })
  mocks.watches[0]?.emit('held')
  expect(f.quit).toHaveBeenCalledOnce()
  tools.emit('blur')
  guest.devToolsWebContents = undefined
  f.dispose()
})

it('admits activity only from its desktop view owner and preserves off/menu lifecycle routes', () => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: guest }, true)
  key(main)
  expect(f.quit).toHaveBeenCalledOnce()
  expect(mocks.watches).toHaveLength(0)
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  key(main)
  f.disable()
  mocks.watches[0]?.emit('held')
  expect(f.quit).toHaveBeenCalledOnce()
  expect(f.rebuildMenu).toHaveBeenCalledOnce()
  key(main)
  expect(f.quit).toHaveBeenCalledOnce()
  f.dispose()
})

it('respects shortcut recording, agent input ownership, blur and destruction', () => {
  const f = fixture()
  ipc.emit('ui:holdQuitActivity', { sender: main }, true)
  ipc.emit('ui:setShortcutRecorderFocused', { sender: main }, true)
  key(main)
  expect(mocks.watches).toHaveLength(0)
  ipc.emit('ui:setShortcutRecorderFocused', { sender: main }, false)
  mocks.injected = true
  key(guest)
  expect(mocks.watches).toHaveLength(0)
  mocks.injected = false
  for (const reason of ['blur', 'destroyed']) {
    key(guest)
    const watch = mocks.watches.at(-1)
    guest.emit(reason)
    watch?.emit('held')
  }
  expect(f.quit).not.toHaveBeenCalled()
  f.dispose()
})
