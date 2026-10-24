import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSourcesMock, fromFrameMock } = vi.hoisted(() => ({
  getSourcesMock: vi.fn(),
  fromFrameMock: vi.fn()
}))

vi.mock('electron', () => ({
  desktopCapturer: { getSources: getSourcesMock },
  webContents: { fromFrame: fromFrameMock }
}))

type Handler = ((request: unknown, callback: (streams: unknown) => void) => void) | null

function fakeRenderer(
  id: number,
  session: { setDisplayMediaRequestHandler: (h: Handler) => void }
) {
  return Object.assign(new EventEmitter(), { id, session }) as unknown as Electron.WebContents
}

function fakeSession() {
  const session = {
    handler: null as Handler,
    setDisplayMediaRequestHandler: vi.fn((handler: Handler) => {
      session.handler = handler
    })
  }
  return session
}

async function loadModule() {
  vi.resetModules()
  return await import('./desktop-app-capture-source')
}

function requestFrom(renderer: Electron.WebContents) {
  const frame = { renderer }
  fromFrameMock.mockImplementation((f: typeof frame) => f.renderer)
  return { frame, videoRequested: true }
}

describe('desktop app capture source', () => {
  const target = { windowId: 12, pid: 42 }

  beforeEach(() => {
    vi.useFakeTimers()
    getSourcesMock.mockResolvedValue([{ id: 'window:12:0' }])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('installs the display-media handler only while a capture is armed', async () => {
    const mod = await loadModule()
    const session = fakeSession()
    const renderer = fakeRenderer(1, session)

    await mod.prepareDesktopAppCapture(renderer, target)
    expect(session.handler).not.toBeNull()

    const callback = vi.fn()
    session.handler?.(requestFrom(renderer), callback)
    expect(callback).toHaveBeenCalledWith({ video: { id: 'window:12:0' } })
    expect(session.handler).toBeNull()
    expect(mod.hasArmedDesktopAppCapture(1)).toBe(false)
  })

  it('denies other requesters while armed and gives the default back after expiry', async () => {
    const mod = await loadModule()
    const session = fakeSession()
    const renderer = fakeRenderer(1, session)
    await mod.prepareDesktopAppCapture(renderer, target)

    const callback = vi.fn()
    session.handler?.(requestFrom(fakeRenderer(2, session)), callback)
    expect(callback).toHaveBeenCalledWith({})
    expect(mod.hasArmedDesktopAppCapture(1)).toBe(true)

    vi.advanceTimersByTime(10_001)
    expect(mod.hasArmedDesktopAppCapture(1)).toBe(false)
    expect(session.handler).toBeNull()
  })

  it('keeps input authorized until the last pane showing the window releases it', async () => {
    const mod = await loadModule()
    const session = fakeSession()
    const renderer = fakeRenderer(1, session)
    await mod.prepareDesktopAppCapture(renderer, target)
    await mod.prepareDesktopAppCapture(renderer, target)

    mod.releaseDesktopAppCapture(renderer, target)
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(true)
    mod.releaseDesktopAppCapture(renderer, target)
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(false)
    expect(session.handler).toBeNull()
  })

  it('never authorizes a pid paired with another window', async () => {
    const mod = await loadModule()
    await mod.prepareDesktopAppCapture(fakeRenderer(1, fakeSession()), target)
    expect(mod.isDesktopAppWindowAuthorized(1, { windowId: 12, pid: 43 })).toBe(false)
  })

  it('drops everything when the renderer is destroyed', async () => {
    const mod = await loadModule()
    const session = fakeSession()
    const renderer = fakeRenderer(1, session)
    await mod.prepareDesktopAppCapture(renderer, target)

    renderer.emit('destroyed')
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(false)
    expect(session.handler).toBeNull()
  })

  it('drops everything when the renderer reloads or crashes', async () => {
    const mod = await loadModule()
    const session = fakeSession()
    const renderer = fakeRenderer(1, session)
    await mod.prepareDesktopAppCapture(renderer, target)

    renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    renderer.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(true)

    renderer.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(false)
    expect(session.handler).toBeNull()

    await mod.prepareDesktopAppCapture(renderer, target)
    renderer.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(mod.isDesktopAppWindowAuthorized(1, target)).toBe(false)
  })
})
