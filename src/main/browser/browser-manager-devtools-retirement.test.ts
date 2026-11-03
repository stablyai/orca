import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))

import { BrowserManager } from './browser-manager'

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
  it.each(['dock', 'detach'] as const)(
    'cancels a first %s open before any native release exists',
    async (mode) => {
      const { manager, guest, renderer, children } = createFixture()
      const opened = manager.openDevTools('page', { x: 1, y: 2 }, { detach: mode === 'detach' })
      manager.closeDevTools('page')

      await expect(opened).resolves.toBe(false)
      expect(native.views).toHaveLength(0)
      expect(children).toHaveLength(0)
      expect(guest.openDevTools).not.toHaveBeenCalled()
      expect(guest.inspectElement).not.toHaveBeenCalled()
      expect(renderer.send).not.toHaveBeenCalled()
    }
  )

  it('toggles a pending first open closed before a frontend exists', async () => {
    const { manager, guest, children } = createFixture()
    const opened = manager.openDevTools('page')
    expect(manager.toggleDevToolsOfFocusedPage(asGuest(guest))).toBe(true)

    await expect(opened).resolves.toBe(false)
    expect(native.views).toHaveLength(0)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).not.toHaveBeenCalled()
  })

  it.each(['dock', 'detach'] as const)(
    'lets a newer open replace an initial %s request',
    async (mode) => {
      const { manager, guest, renderer, children } = createFixture()
      const first = manager.openDevTools('page', { x: 1, y: 2 }, { detach: mode === 'detach' })
      const latest = manager.openDevTools('page', undefined, { detach: mode !== 'detach' })

      await expect(first).resolves.toBe(false)
      await expect(latest).resolves.toBe(true)
      expect(guest.openDevTools).toHaveBeenCalledTimes(1)
      expect(guest.inspectElement).not.toHaveBeenCalled()
      expect(children).toHaveLength(mode === 'detach' ? 1 : 0)
      if (mode === 'dock') {
        expect(guest.openDevTools).toHaveBeenLastCalledWith({ mode: 'detach' })
        expect(renderer.send).not.toHaveBeenCalledWith('browser:devToolsDockChanged', {
          browserPageId: 'page',
          docked: true
        })
      }
    }
  )

  it.each(['close', 'unregister'] as const)(
    'honors %s after native attach before manager completion',
    async (action) => {
      const { manager, guest, renderer, children } = createFixture()
      const opened = manager.openDevTools('page', { x: 1, y: 2 })
      await Promise.resolve()
      expect(children).toHaveLength(1)
      expect(renderer.send).not.toHaveBeenCalled()
      if (action === 'close') {
        manager.closeDevTools('page')
      } else {
        manager.unregisterGuest('page')
      }

      await expect(opened).resolves.toBe(false)
      expect(children).toHaveLength(0)
      expect(guest.openDevTools).toHaveBeenCalledTimes(1)
      expect(guest.inspectElement).not.toHaveBeenCalled()
      expect(renderer.send).not.toHaveBeenCalledWith('browser:devToolsDockChanged', {
        browserPageId: 'page',
        docked: true
      })
      native.views[0].release()
    }
  )

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

  it('does not fall back after an unavailable dock request was closed', async () => {
    const { manager, guest, children } = createFixture()
    native.window = null
    const opened = manager.openDevTools('page', { x: 1, y: 2 })
    await Promise.resolve()
    manager.closeDevTools('page')

    await expect(opened).resolves.toBe(false)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).not.toHaveBeenCalled()
    expect(guest.inspectElement).not.toHaveBeenCalled()
  })

  it('skips inspect when the detached fallback closes before its await resumes', async () => {
    const { manager, guest, children } = createFixture()
    native.window = null
    guest.openDevTools.mockImplementationOnce(() => {
      queueMicrotask(() => manager.closeDevTools('page'))
    })

    await expect(manager.openDevTools('page', { x: 1, y: 2 })).resolves.toBe(false)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
    expect(guest.inspectElement).not.toHaveBeenCalled()
  })

  it('keeps detached fallback and inspect for a surviving owner', async () => {
    const { manager, guest, renderer, children } = createFixture()
    native.window = null

    await expect(manager.openDevTools('page', { x: 1, y: 2 })).resolves.toBe(true)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
    expect(guest.inspectElement).toHaveBeenCalledExactlyOnceWith(1, 2)
    expect(renderer.send).not.toHaveBeenCalled()
  })

  it('retires an attached old guest when registration changes before manager completion', async () => {
    const { manager, guest, renderer, children } = createFixture()
    const opened = manager.openDevTools('page', { x: 1, y: 2 })
    await Promise.resolve()
    expect(children).toHaveLength(1)
    const replacement = createGuest(102)
    manager.attachGuestPolicies(asGuest(replacement.guest))
    manager.registerGuest(
      {
        browserPageId: 'page',
        webContentsId: replacement.guest.id,
        rendererWebContentsId: renderer.id
      },
      { retainPreviousGuestPolicies: true }
    )

    await expect(opened).resolves.toBe(false)
    expect(children).toHaveLength(0)
    expect(guest.inspectElement).not.toHaveBeenCalled()
    expect(renderer.send).not.toHaveBeenCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'page',
      docked: true
    })
    native.views[0].release()
    await expect(manager.openDevTools('page')).resolves.toBe(true)
    expect(children).toHaveLength(1)
  })

  it.each(['close', 'toggle'] as const)(
    'honors a later %s while a dock reopen waits',
    async (action) => {
      const { manager, guest, renderer, children } = createFixture()
      await manager.openDevTools('page')
      manager.closeDevTools('page')
      const reopened = manager.openDevTools('page', { x: 1, y: 2 })

      if (action === 'close') {
        manager.closeDevTools('page')
      } else {
        expect(manager.toggleDevToolsOfFocusedPage(asGuest(guest))).toBe(true)
      }
      expect(native.views).toHaveLength(1)
      native.views[0].release()

      await expect(reopened).resolves.toBe(false)
      expect(children).toHaveLength(0)
      expect(guest.openDevTools).toHaveBeenCalledTimes(1)
      expect(guest.inspectElement).not.toHaveBeenCalled()
      expect(renderer.send).toHaveBeenLastCalledWith('browser:devToolsDockChanged', {
        browserPageId: 'page',
        docked: false
      })
    }
  )

  it('honors a later detach without recreating a dock or falling back twice', async () => {
    const { manager, guest, renderer, children } = createFixture()
    await manager.openDevTools('page')
    manager.closeDevTools('page')
    const reopened = manager.openDevTools('page')
    const detached = manager.openDevTools('page', undefined, { detach: true })
    native.views[0].release()

    await expect(reopened).resolves.toBe(false)
    await expect(detached).resolves.toBe(true)
    expect(native.views).toHaveLength(1)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).toHaveBeenCalledTimes(2)
    expect(guest.openDevTools).toHaveBeenLastCalledWith({ mode: 'detach' })
    expect(renderer.send).toHaveBeenLastCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'page',
      docked: false
    })
  })

  it.each(['dock', 'detach'] as const)(
    'retires a pending %s open when a live guest is unregistered',
    async (mode) => {
      const { manager, guest, renderer, children } = createFixture()
      await manager.openDevTools('page')
      manager.closeDevTools('page')
      const reopened = manager.openDevTools('page', undefined, { detach: mode === 'detach' })
      renderer.send.mockClear()
      manager.unregisterGuest('page')
      native.views[0].release()

      await expect(reopened).resolves.toBe(false)
      expect(guest.isDestroyed()).toBe(false)
      expect(manager.getGuestWebContentsId('page')).toBeNull()
      expect(children).toHaveLength(0)
      expect(guest.openDevTools).toHaveBeenCalledTimes(1)
      expect(renderer.send).not.toHaveBeenCalledWith('browser:devToolsDockChanged', {
        browserPageId: 'page',
        docked: true
      })
    }
  )

  it('honors a close that arrives while a detached open waits', async () => {
    const { manager, guest, children } = createFixture()
    await manager.openDevTools('page')
    const detached = manager.openDevTools('page', undefined, { detach: true })
    manager.closeDevTools('page')
    native.views[0].release()

    await expect(detached).resolves.toBe(false)
    expect(children).toHaveLength(0)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
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

  it('creates no frontend when a guest is destroyed while release is pending', async () => {
    const { manager, guest, destroy, children } = createFixture()
    await manager.openDevTools('page')
    manager.closeDevTools('page')
    const reopened = manager.openDevTools('page')
    destroy()
    native.views[0].release()

    await expect(reopened).resolves.toBe(false)
    expect(children).toHaveLength(0)
    expect(native.views).toHaveLength(1)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
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

  it('undocks the renderer when a retained old guest closes its dock', async () => {
    const { manager, destroy, renderer } = createFixture()
    await expect(manager.openDevTools('page')).resolves.toBe(true)
    const replacement = createGuest(102)
    manager.attachGuestPolicies(asGuest(replacement.guest))
    manager.registerGuest(
      {
        browserPageId: 'page',
        webContentsId: replacement.guest.id,
        rendererWebContentsId: renderer.id
      },
      { retainPreviousGuestPolicies: true }
    )
    renderer.send.mockClear()
    destroy()

    expect(renderer.send).toHaveBeenCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'page',
      docked: false
    })
  })

  it('does not attach to a renderer retired while release is pending', async () => {
    const { manager, guest, renderer, children } = createFixture()
    await manager.openDevTools('page')
    manager.closeDevTools('page')
    const reopened = manager.openDevTools('page')
    renderer.isDestroyed.mockReturnValue(true)
    native.views[0].release()

    await expect(reopened).resolves.toBe(false)
    expect(guest.openDevTools).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(0)
  })
})
