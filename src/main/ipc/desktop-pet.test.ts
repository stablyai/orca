import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  ipcMainMock,
  createWindowMock,
  closeWindowMock,
  getWindowMock,
  isPetRendererMock,
  moveWindowMock,
  setInteractiveMock,
  isTrustedUIRendererMock,
  sendToTrustedMock
} = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers: map,
    ipcMainMock: {
      removeHandler: vi.fn(),
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn)
    },
    createWindowMock: vi.fn(),
    closeWindowMock: vi.fn(),
    getWindowMock: vi.fn((): unknown => null),
    isPetRendererMock: vi.fn((_sender: unknown) => false),
    moveWindowMock: vi.fn(),
    setInteractiveMock: vi.fn(),
    isTrustedUIRendererMock: vi.fn((_sender: unknown) => false),
    sendToTrustedMock: vi.fn()
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('../window/desktop-pet-window', () => ({
  createOrRevealDesktopPetWindow: createWindowMock,
  closeDesktopPetWindow: closeWindowMock,
  getDesktopPetWindow: getWindowMock,
  isDesktopPetRenderer: isPetRendererMock,
  moveDesktopPetWindow: moveWindowMock,
  setDesktopPetInteractive: setInteractiveMock
}))
vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock,
  sendToTrustedUIRenderer: sendToTrustedMock
}))

import { registerDesktopPetHandlers, shouldShowDesktopPetWindow } from './desktop-pet'

const mainSender = { id: 1, send: vi.fn() }
const petSender = { id: 2, send: vi.fn() }

function createStore() {
  const uiListeners: (() => void)[] = []
  const settingsListeners: ((updates: Record<string, unknown>) => void)[] = []
  const store = {
    ui: { petDetached: false, petVisible: true } as Record<string, unknown>,
    settings: { experimentalPet: true } as Record<string, unknown>,
    getUI: () => store.ui,
    getSettings: () => store.settings,
    updateUI: vi.fn(),
    onUIChanged: (listener: () => void) => uiListeners.push(listener),
    onSettingsChanged: (listener: (updates: Record<string, unknown>) => void) =>
      settingsListeners.push(listener),
    emitUIChanged: () => uiListeners.forEach((listener) => listener()),
    emitSettingsChanged: (updates: Record<string, unknown>) =>
      settingsListeners.forEach((listener) => listener(updates))
  }
  return store
}

describe('shouldShowDesktopPetWindow', () => {
  it('requires the experiment, the detach toggle, and a pet that is not hidden', () => {
    expect(shouldShowDesktopPetWindow({ petDetached: true, petVisible: true }, true)).toBe(true)
    expect(shouldShowDesktopPetWindow({ petDetached: true, petVisible: true }, false)).toBe(false)
    expect(shouldShowDesktopPetWindow({ petDetached: false, petVisible: true }, true)).toBe(false)
    expect(shouldShowDesktopPetWindow({ petDetached: true, petVisible: false }, true)).toBe(false)
  })

  it('treats an absent petVisible as visible, matching the persisted default', () => {
    expect(shouldShowDesktopPetWindow({ petDetached: true }, true)).toBe(true)
  })
})

describe('registerDesktopPetHandlers', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    handlers.clear()
    store = createStore()
    isTrustedUIRendererMock.mockImplementation((sender) => sender === mainSender)
    isPetRendererMock.mockImplementation((sender) => sender === petSender)
  })

  afterEach(() => {
    vi.clearAllMocks()
    getWindowMock.mockReturnValue(null)
  })

  it('opens and closes the window as the detach toggle flips', () => {
    registerDesktopPetHandlers(store as never)
    expect(closeWindowMock).toHaveBeenCalled()
    expect(createWindowMock).not.toHaveBeenCalled()

    store.ui.petDetached = true
    store.emitUIChanged()
    expect(createWindowMock).toHaveBeenCalledWith(store)

    store.ui.petDetached = false
    store.emitUIChanged()
    expect(closeWindowMock).toHaveBeenCalledTimes(2)
  })

  it('closes the window when the pet experiment is turned off', () => {
    store.ui.petDetached = true
    registerDesktopPetHandlers(store as never)
    expect(createWindowMock).toHaveBeenCalledTimes(1)

    store.settings.experimentalPet = false
    store.emitSettingsChanged({ experimentalPet: false })
    expect(closeWindowMock).toHaveBeenCalled()
  })

  it('forwards a published animation to the pet window', () => {
    const petWindow = { webContents: { send: vi.fn() } }
    getWindowMock.mockReturnValue(petWindow)
    registerDesktopPetHandlers(store as never)

    handlers.get('desktopPet:publishAnimation')?.({ sender: mainSender }, 'running')
    expect(petWindow.webContents.send).toHaveBeenCalledWith('desktopPet:animation', 'running')
  })

  it('drops publishes from an untrusted sender or with an unknown animation', () => {
    const petWindow = { webContents: { send: vi.fn() } }
    getWindowMock.mockReturnValue(petWindow)
    registerDesktopPetHandlers(store as never)

    handlers.get('desktopPet:publishAnimation')?.({ sender: petSender }, 'running')
    handlers.get('desktopPet:publishAnimation')?.({ sender: mainSender }, 'sprinting')
    expect(petWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('replays the last animation to a pet window that just mounted, then asks for a fresh one', () => {
    getWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDesktopPetHandlers(store as never)
    handlers.get('desktopPet:publishAnimation')?.({ sender: mainSender }, 'waiting')

    handlers.get('desktopPet:requestAnimation')?.({ sender: petSender })
    expect(petSender.send).toHaveBeenCalledWith('desktopPet:animation', 'waiting')
    expect(sendToTrustedMock).toHaveBeenCalledWith('desktopPet:animationRequested', null)
  })

  it('forgets the cached animation once the window closes so a re-detach cannot replay it', () => {
    getWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    store.ui.petDetached = true
    registerDesktopPetHandlers(store as never)
    handlers.get('desktopPet:publishAnimation')?.({ sender: mainSender }, 'waiting')

    store.ui.petDetached = false
    store.emitUIChanged()
    petSender.send.mockClear()
    handlers.get('desktopPet:requestAnimation')?.({ sender: petSender })
    expect(petSender.send).not.toHaveBeenCalled()
  })

  it('accepts move and interactivity only from the pet window itself', () => {
    registerDesktopPetHandlers(store as never)

    handlers.get('desktopPet:move')?.({ sender: petSender }, { x: 12, y: 34 })
    expect(moveWindowMock).toHaveBeenCalledWith(store, { x: 12, y: 34 })

    handlers.get('desktopPet:move')?.({ sender: mainSender }, { x: 1, y: 2 })
    handlers.get('desktopPet:move')?.({ sender: petSender }, { x: 'left', y: 2 })
    expect(moveWindowMock).toHaveBeenCalledTimes(1)

    handlers.get('desktopPet:setInteractive')?.({ sender: petSender }, true)
    handlers.get('desktopPet:setInteractive')?.({ sender: mainSender }, false)
    handlers.get('desktopPet:setInteractive')?.({ sender: petSender }, 'yes')
    expect(setInteractiveMock).toHaveBeenCalledTimes(1)
    expect(setInteractiveMock).toHaveBeenCalledWith(true)
  })
})
