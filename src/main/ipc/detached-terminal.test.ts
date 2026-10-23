import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  ipcMainMock,
  createOrFocusMock,
  closeDetachedMock,
  isDetachedRendererForTabMock,
  isTrustedUIRendererMock
} = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers: map,
    ipcMainMock: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn),
      removeHandler: vi.fn((channel: string) => map.delete(channel))
    },
    createOrFocusMock: vi.fn(),
    closeDetachedMock: vi.fn(),
    isDetachedRendererForTabMock: vi.fn((_sender: unknown, _tabId: string) => false),
    isTrustedUIRendererMock: vi.fn((_sender: unknown) => false)
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('../window/detached-terminal-window', () => ({
  createOrFocusDetachedTerminalWindow: createOrFocusMock,
  closeDetachedTerminalWindow: closeDetachedMock,
  isDetachedTerminalRendererForTab: isDetachedRendererForTabMock
}))
vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import { MAX_DETACHED_TERMINAL_TITLE_LENGTH } from '../../shared/detached-terminal-limits'
import { registerDetachedTerminalHandlers } from './detached-terminal'

describe('detached terminal IPC handlers', () => {
  const trustedSender = { id: 1 }
  const untrustedSender = { id: 2 }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    isTrustedUIRendererMock.mockImplementation((sender) => sender === trustedSender)
    registerDetachedTerminalHandlers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers open, close, and returnToMain handlers', () => {
    expect(handlers.has('detachedTerminal:open')).toBe(true)
    expect(handlers.has('detachedTerminal:close')).toBe(true)
    expect(handlers.has('detachedTerminal:returnToMain')).toBe(true)
  })

  it('opens a detached terminal window and returns true for valid trusted input', () => {
    const openHandler = handlers.get('detachedTerminal:open')!
    const result = openHandler(
      { sender: trustedSender },
      {
        tabId: 'tab-1',
        ptyId: 'pty-1',
        title: 'Terminal 1'
      }
    )

    expect(result).toBe(true)
    expect(createOrFocusMock).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      title: 'Terminal 1'
    })
  })

  it('rejects open when caller is not trusted UI renderer', () => {
    const openHandler = handlers.get('detachedTerminal:open')!
    const result = openHandler(
      { sender: untrustedSender },
      {
        tabId: 'tab-1',
        ptyId: 'pty-1',
        title: 'Terminal 1'
      }
    )

    expect(result).toBe(false)
    expect(createOrFocusMock).not.toHaveBeenCalled()
  })

  it('rejects open when title exceeds maximum length', () => {
    const openHandler = handlers.get('detachedTerminal:open')!
    const longTitle = 'a'.repeat(MAX_DETACHED_TERMINAL_TITLE_LENGTH + 1)
    const result = openHandler(
      { sender: trustedSender },
      {
        tabId: 'tab-1',
        ptyId: 'pty-1',
        title: longTitle
      }
    )

    expect(result).toBe(false)
    expect(createOrFocusMock).not.toHaveBeenCalled()
  })

  it('rejects open when arguments are missing or malformed', () => {
    const openHandler = handlers.get('detachedTerminal:open')!
    expect(openHandler({ sender: trustedSender }, null)).toBe(false)
    expect(openHandler({ sender: trustedSender }, {})).toBe(false)
    expect(
      openHandler({ sender: trustedSender }, { tabId: '', ptyId: 'pty-1', title: 'test' })
    ).toBe(false)
    expect(
      openHandler({ sender: trustedSender }, { tabId: 'tab-1', ptyId: '', title: 'test' })
    ).toBe(false)
    expect(
      openHandler({ sender: trustedSender }, { tabId: 'tab-1', ptyId: 'pty-1', title: '' })
    ).toBe(false)
    expect(createOrFocusMock).not.toHaveBeenCalled()
  })

  it('closes detached terminal window for trusted caller', () => {
    const closeHandler = handlers.get('detachedTerminal:close')!
    closeHandler({ sender: trustedSender }, { tabId: 'tab-1' })
    expect(closeDetachedMock).toHaveBeenCalledWith('tab-1')
  })

  it('ignores close for untrusted caller', () => {
    const closeHandler = handlers.get('detachedTerminal:close')!
    closeHandler({ sender: untrustedSender }, { tabId: 'tab-1' })
    expect(closeDetachedMock).not.toHaveBeenCalled()
  })

  it('handles returnToMain when sender is detached renderer for that tab', () => {
    const returnHandler = handlers.get('detachedTerminal:returnToMain')!
    const companionSender = { id: 3 }
    isDetachedRendererForTabMock.mockImplementation(
      (sender, tabId) => sender === companionSender && tabId === 'tab-1'
    )

    returnHandler({ sender: companionSender }, { tabId: 'tab-1' })
    expect(closeDetachedMock).toHaveBeenCalledWith('tab-1')
  })

  it('rejects returnToMain when sender does not match the tab companion renderer', () => {
    const returnHandler = handlers.get('detachedTerminal:returnToMain')!
    returnHandler({ sender: untrustedSender }, { tabId: 'tab-1' })
    expect(closeDetachedMock).not.toHaveBeenCalled()
  })
})
