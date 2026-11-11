// @orca-isolated-worker: cached Electron mocks can omit BrowserWindow across shared files.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'

type DevToolsHost = EventEmitter & { isDestroyed: () => boolean }
type HeldDevToolsView = { release: () => void; destroyed: boolean }

const native = vi.hoisted(() => {
  const views: HeldDevToolsView[] = []
  const state: { views: HeldDevToolsView[]; byId: Map<number, unknown>; window: unknown } = {
    views,
    byId: new Map(),
    window: undefined
  }
  return state
})

vi.mock('electron', () => {
  class View {
    destroyed = false
    host = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed,
      close: vi.fn(),
      focus: vi.fn()
    })
    constructor() {
      native.views.push(this)
    }
    get webContents(): DevToolsHost | null {
      return this.destroyed ? null : this.host
    }
    setVisible(): void {}
    release(): void {
      this.destroyed = true
      this.host.emit('destroyed')
    }
  }
  return {
    WebContentsView: View,
    BrowserWindow: { fromWebContents: () => native.window },
    app: { getPath: () => '/downloads' },
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn() },
    Menu: { buildFromTemplate: vi.fn() },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    webContents: { fromId: (id: number) => native.byId.get(id) }
  }
})
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))

function createGuest(id: number) {
  let destroyed = false
  let opened = false
  const frontend: { devToolsWebContents: DevToolsHost | null } = { devToolsWebContents: null }
  const guest = Object.assign(new EventEmitter(), frontend, {
    id,
    hostWebContents: {},
    getType: () => 'webview',
    getURL: () => 'https://example.com/',
    isCurrentlyAudible: () => false,
    isDestroyed: () => destroyed,
    isDevToolsOpened: () => opened,
    setWindowOpenHandler: vi.fn(),
    setDevToolsWebContents: vi.fn((host: DevToolsHost) => {
      guest.devToolsWebContents = host
      host.once('destroyed', () => {
        opened = false
        guest.devToolsWebContents = null
        guest.emit('devtools-closed')
      })
    }),
    openDevTools: vi.fn((_options?: { mode?: string }) => {
      opened = true
    }),
    closeDevTools: vi.fn(() => {
      opened = false
    }),
    inspectElement: vi.fn(),
    send: vi.fn()
  })
  native.byId.set(id, guest)
  return {
    guest,
    destroy: () => {
      destroyed = true
      opened = false
      guest.emit('destroyed')
    }
  }
}

function asGuest(guest: ReturnType<typeof createGuest>['guest']): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the guest members used by registration, policy, and DevTools.
  return guest as unknown as Electron.WebContents
}

function createFixture() {
  const { guest, destroy } = createGuest(101)
  const renderer = { id: 5001, isDestroyed: vi.fn(() => false), send: vi.fn() }
  native.byId.set(renderer.id, renderer)
  const children: unknown[] = []
  native.window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: unknown) => children.push(view),
      removeChildView: (view: unknown) => {
        const index = children.indexOf(view)
        if (index !== -1) {
          children.splice(index, 1)
        }
      }
    }
  }
  const manager = new BrowserManager()
  manager.setSettingsResolver(() => ({}))
  manager.attachGuestPolicies(asGuest(guest))
  expect(
    manager.registerGuest({
      browserPageId: 'page',
      webContentsId: guest.id,
      rendererWebContentsId: renderer.id
    })
  ).toBe(true)
  renderer.send.mockClear()
  return { manager, guest, destroy, renderer, children }
}

beforeEach(() => {
  native.views.length = 0
  native.byId.clear()
})

describe('pending page DevTools retirement', () => {
  it('keeps a newer dock owner when the older opening finishes', async () => {
    const { manager, guest, renderer, children } = createFixture()
    const first = manager.openDevTools('page', { x: 1, y: 2 })
    await Promise.resolve()
    expect(children).toHaveLength(1)
    const latest = manager.openDevTools('page')

    await expect(first).resolves.toBe(false)
    await expect(latest).resolves.toBe(true)
    expect(children).toHaveLength(1)
    expect(native.views).toHaveLength(1)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
    expect(guest.inspectElement).not.toHaveBeenCalled()
    expect(renderer.send).toHaveBeenLastCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'page',
      docked: true
    })
  })

  it('reopens for a surviving owner after the old host releases', async () => {
    const { manager, guest, children } = createFixture()
    await manager.openDevTools('page')
    manager.closeDevTools('page')
    const superseded = manager.openDevTools('page')
    manager.closeDevTools('page')
    const reopened = manager.openDevTools('page')
    expect(native.views).toHaveLength(1)
    native.views[0].release()

    await expect(superseded).resolves.toBe(false)
    await expect(reopened).resolves.toBe(true)
    expect(manager.getGuestWebContentsId('page')).toBe(guest.id)
    expect(children).toHaveLength(1)
    expect(guest.openDevTools).toHaveBeenCalledTimes(2)
    expect(native.views).toHaveLength(2)
  })

  it('does not reopen an old guest retained during registration replacement', async () => {
    const { manager, guest, renderer, children } = createFixture()
    await manager.openDevTools('page')
    manager.closeDevTools('page')
    const reopened = manager.openDevTools('page')
    const replacement = createGuest(102)
    manager.attachGuestPolicies(asGuest(replacement.guest))
    expect(
      manager.registerGuest(
        {
          browserPageId: 'page',
          webContentsId: replacement.guest.id,
          rendererWebContentsId: renderer.id
        },
        { retainPreviousGuestPolicies: true }
      )
    ).toBe(true)
    native.views[0].release()

    await expect(reopened).resolves.toBe(false)
    expect(guest.isDestroyed()).toBe(false)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(0)
    await expect(manager.openDevTools('page')).resolves.toBe(true)
    expect(replacement.guest.openDevTools).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(1)
  })
})
