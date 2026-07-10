import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SystemTrayModule from './system-tray'

const {
  trayInstances,
  menuFromTemplateMock,
  createAppIconImageMock,
  composeAttentionMock,
  resizedImage
} = vi.hoisted(() => {
  const resizedImage = { resized: true }
  return {
    trayInstances: [] as FakeTray[],
    menuFromTemplateMock: vi.fn((template: unknown) => ({ template })),
    createAppIconImageMock: vi.fn(),
    composeAttentionMock: vi.fn((image: unknown) => ({ dotted: image })),
    resizedImage
  }
})

class FakeTray {
  setToolTip = vi.fn()
  setContextMenu = vi.fn()
  setImage = vi.fn()
  on = vi.fn()
  destroy = vi.fn()
  isDestroyed = vi.fn(() => false)
  constructor(public readonly image: unknown) {
    trayInstances.push(this)
  }
}

vi.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: menuFromTemplateMock }
}))

vi.mock('../app-icon', () => ({
  createAppIconImage: createAppIconImageMock
}))

vi.mock('./tray-attention-icon', () => ({
  composeTrayAttentionIcon: composeAttentionMock
}))

type TrayModule = typeof SystemTrayModule

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

async function loadModule(): Promise<TrayModule> {
  vi.resetModules()
  return import('./system-tray')
}

type MenuItem = { label?: string; type?: string; click?: () => void }

function builtMenuItems(): MenuItem[] {
  return menuFromTemplateMock.mock.calls.at(-1)?.[0] as MenuItem[]
}

beforeEach(() => {
  trayInstances.length = 0
  menuFromTemplateMock.mockClear()
  composeAttentionMock.mockClear()
  createAppIconImageMock.mockReset()
  createAppIconImageMock.mockReturnValue({ resize: vi.fn(() => resizedImage) })
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('createSystemTray', () => {
  it('creates a tray with an Orca tooltip and Open/Quit menu on win32', async () => {
    setPlatform('win32')
    const { createSystemTray } = await loadModule()
    const onOpen = vi.fn()
    const onQuit = vi.fn()

    const tray = createSystemTray({ appIcon: 'classic', onOpen, onQuit })

    expect(tray).not.toBeNull()
    expect(trayInstances).toHaveLength(1)
    expect(trayInstances[0].image).toBe(resizedImage)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('Orca')
    const items = builtMenuItems()
    expect(items.map((i) => i.label)).toEqual(['Open Orca', undefined, 'Quit'])
    expect(items[1].type).toBe('separator')
  })

  it('wires Open Orca, the tray click, and Quit to their callbacks', async () => {
    setPlatform('win32')
    const { createSystemTray } = await loadModule()
    const onOpen = vi.fn()
    const onQuit = vi.fn()

    createSystemTray({ appIcon: 'classic', onOpen, onQuit })

    const items = builtMenuItems()
    items.find((i) => i.label === 'Open Orca')?.click?.()
    expect(onOpen).toHaveBeenCalledTimes(1)

    const clickHandler = trayInstances[0].on.mock.calls.find((c) => c[0] === 'click')?.[1] as
      | (() => void)
      | undefined
    clickHandler?.()
    expect(onOpen).toHaveBeenCalledTimes(2)

    items.find((i) => i.label === 'Quit')?.click?.()
    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second call does not create a duplicate tray', async () => {
    setPlatform('win32')
    const { createSystemTray } = await loadModule()
    const opts = { appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() }

    const first = createSystemTray(opts)
    const second = createSystemTray(opts)

    expect(trayInstances).toHaveLength(1)
    expect(second).toBe(first)
  })

  it('is a no-op on non-win32 platforms', async () => {
    setPlatform('darwin')
    const { createSystemTray } = await loadModule()

    const tray = createSystemTray({ appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() })

    expect(tray).toBeNull()
    expect(trayInstances).toHaveLength(0)
  })
})

describe('setTrayAttention', () => {
  it('swaps in the dotted icon when active and restores the base when cleared', async () => {
    setPlatform('win32')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray({ appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() })
    const tray = trayInstances[0]
    tray.setImage.mockClear()

    setTrayAttention(true)
    expect(composeAttentionMock).toHaveBeenCalledWith(resizedImage)
    expect(tray.setImage).toHaveBeenCalledWith({ dotted: resizedImage })

    tray.setImage.mockClear()
    setTrayAttention(false)
    expect(tray.setImage).toHaveBeenCalledWith(resizedImage)
  })

  it('ignores repeated same-state calls', async () => {
    setPlatform('win32')
    const { createSystemTray, setTrayAttention } = await loadModule()
    createSystemTray({ appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() })
    const tray = trayInstances[0]
    tray.setImage.mockClear()

    setTrayAttention(true)
    setTrayAttention(true)

    expect(tray.setImage).toHaveBeenCalledTimes(1)
  })

  it('reflects attention that was requested before the tray was created', async () => {
    setPlatform('win32')
    const { createSystemTray, setTrayAttention } = await loadModule()

    // Fire the event before the (deferred) tray exists.
    setTrayAttention(true)
    createSystemTray({ appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() })
    const tray = trayInstances[0]

    expect(tray.setImage).toHaveBeenCalledWith({ dotted: resizedImage })
  })

  it('is a safe no-op on non-win32 platforms', async () => {
    setPlatform('darwin')
    const { setTrayAttention } = await loadModule()

    expect(() => setTrayAttention(true)).not.toThrow()
    expect(composeAttentionMock).not.toHaveBeenCalled()
  })
})

describe('destroySystemTray', () => {
  it('destroys an existing tray and is safe to call without one', async () => {
    setPlatform('win32')
    const { createSystemTray, destroySystemTray } = await loadModule()
    createSystemTray({ appIcon: 'classic', onOpen: vi.fn(), onQuit: vi.fn() })
    const created = trayInstances[0]

    destroySystemTray()
    expect(created.destroy).toHaveBeenCalledTimes(1)

    // Second call with no live tray must not throw.
    expect(() => destroySystemTray()).not.toThrow()
  })
})
