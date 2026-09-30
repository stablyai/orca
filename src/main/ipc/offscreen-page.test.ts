import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: { sender: FakeRenderer }, ...args: unknown[]) => unknown
type FakeRenderer = { id: number; once: () => void; on: () => void }

const { handlers, listeners, host, trusted, admissible } = vi.hoisted(() => ({
  handlers: new Map<string, Listener>(),
  listeners: new Map<string, Listener>(),
  host: {
    create: vi.fn(() => ({ id: 77 })),
    isOwnedBy: vi.fn((pageId: string, rendererId: number) => pageId === 'p1' && rendererId === 1),
    dispatchUserInput: vi.fn(() => Promise.resolve()),
    setViewport: vi.fn(),
    runCommand: vi.fn(),
    focusPage: vi.fn(),
    close: vi.fn(),
    closeOwnedBy: vi.fn(),
    readCaret: vi.fn()
  },
  trusted: { value: true },
  admissible: { value: true }
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: (channel: string, listener: Listener) => listeners.set(channel, listener)
  }
}))
vi.mock('../browser/offscreen-page-host', () => ({
  OffscreenPageHost: function OffscreenPageHost() {
    return host
  }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => trusted.value }))
vi.mock('../browser/browser-page-guest-admission', () => ({
  isAdmissibleBrowserPageGuest: () => admissible.value
}))

import { registerOffscreenPageHandlers } from './offscreen-page'

const owner: FakeRenderer = { id: 1, once: vi.fn(), on: vi.fn() }
const stranger: FakeRenderer = { id: 2, once: vi.fn(), on: vi.fn() }
const createArgs = {
  browserPageId: 'p1',
  partition: 'persist:orca-browser',
  src: 'https://example.com',
  viewport: { width: 800, height: 600, visible: true }
}
const keyInput = {
  kind: 'key',
  type: 'keyDown',
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  location: 0,
  repeat: false,
  text: 'a',
  modifiers: []
}

describe('offscreen page IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trusted.value = true
    admissible.value = true
    registerOffscreenPageHandlers()
  })

  it('creates an admitted page for a trusted renderer and returns its WebContents id', () => {
    expect(handlers.get('offscreenPage:create')?.({ sender: owner }, createArgs)).toBe(77)
    expect(host.create).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'p1', rendererWebContentsId: 1 })
    )
  })

  it('refuses creation from an untrusted renderer, for a refused or routed partition, or with bad args', () => {
    admissible.value = false
    expect(handlers.get('offscreenPage:create')?.({ sender: owner }, createArgs)).toBeNull()
    admissible.value = true
    trusted.value = false
    expect(handlers.get('offscreenPage:create')?.({ sender: owner }, createArgs)).toBeNull()
    trusted.value = true
    expect(
      handlers.get('offscreenPage:create')?.({ sender: owner }, { browserPageId: 'p1' })
    ).toBeNull()
    expect(
      handlers.get('offscreenPage:create')?.(
        { sender: owner },
        { ...createArgs, partition: `persist:orca-browser-v1-${'a'.repeat(64)}` }
      )
    ).toBeNull()
    expect(host.create).not.toHaveBeenCalled()
  })

  it('delivers input only from the renderer that owns the page', () => {
    listeners.get('offscreenPage:input')?.({ sender: stranger }, 'p1', keyInput)
    expect(host.dispatchUserInput).not.toHaveBeenCalled()
    listeners.get('offscreenPage:input')?.({ sender: owner }, 'p1', keyInput)
    expect(host.dispatchUserInput).toHaveBeenCalledWith('p1', keyInput)
  })

  it('drops input that does not match the protocol', () => {
    listeners.get('offscreenPage:input')?.({ sender: owner }, 'p1', { kind: 'eval', code: 'x' })
    listeners.get('offscreenPage:command')?.({ sender: owner }, 'p1', { kind: 'executeJavaScript' })
    expect(host.dispatchUserInput).not.toHaveBeenCalled()
    expect(host.runCommand).not.toHaveBeenCalled()
  })

  it('lets only the owner close its page', () => {
    listeners.get('offscreenPage:close')?.({ sender: stranger }, 'p1')
    expect(host.close).not.toHaveBeenCalled()
    listeners.get('offscreenPage:close')?.({ sender: owner }, 'p1')
    expect(host.close).toHaveBeenCalledWith('p1')
  })
})
