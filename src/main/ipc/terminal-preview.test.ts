import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => unknown

const {
  handlers,
  isDashboardPopoutRendererMock,
  isTrustedUIRendererMock,
  isWorkspacePopoutRendererMock,
  mockRuntime
} = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>()
  return {
    handlers,
    isDashboardPopoutRendererMock: vi.fn(),
    isTrustedUIRendererMock: vi.fn(),
    isWorkspacePopoutRendererMock: vi.fn(),
    mockRuntime: {
      serializeTerminalBuffer: vi.fn(),
      registerRawTerminalViewSubscriber: vi.fn(() => () => {}),
      subscribeToTerminalData: vi.fn(() => () => {}),
      subscribeToTerminalResize: vi.fn(() => () => {}),
      updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
      unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      writeTerminalPreviewInput: vi.fn().mockResolvedValue(true)
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    handle: vi.fn((ch: string, fn: IpcHandler) => handlers.set(ch, fn))
  }
}))

vi.mock('../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: isDashboardPopoutRendererMock
}))

vi.mock('../window/workspace-popout-window', () => ({
  isWorkspacePopoutRenderer: isWorkspacePopoutRendererMock
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

vi.mock('./renderer-lifetime-abort', () => ({
  abortWhenRendererGone: vi.fn(() => ({
    signal: { addEventListener: vi.fn() },
    dispose: vi.fn()
  }))
}))

import { registerTerminalPreviewHandlers } from './terminal-preview'

describe('terminal-preview', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates mock WebContents sender tokens
  const trustedSender = { id: 1 } as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates mock WebContents sender tokens
  const satelliteSender = { id: 2 } as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates mock WebContents sender tokens
  const dashboardSender = { id: 3 } as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture creates mock WebContents sender tokens
  const untrustedSender = { id: 99 } as unknown as Electron.WebContents

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    const mockRuntimeUnknown: unknown = mockRuntime
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies mock runtime methods
    const runtimeParam = mockRuntimeUnknown as Parameters<typeof registerTerminalPreviewHandlers>[0]
    registerTerminalPreviewHandlers(runtimeParam)

    isTrustedUIRendererMock.mockImplementation((s: unknown) => s === trustedSender)
    isWorkspacePopoutRendererMock.mockImplementation((s: unknown) => s === satelliteSender)
    isDashboardPopoutRendererMock.mockImplementation((s: unknown) => s === dashboardSender)
  })

  describe('terminalPreview:connect', () => {
    it('rejects untrusted sender', async () => {
      const res = await handlers.get('terminalPreview:connect')?.(
        { sender: untrustedSender },
        { ptyId: 'pty-1' }
      )
      expect(res).toEqual({ snapshot: null, replay: [] })
    })

    it('accepts satellite sender and requests snapshot', async () => {
      mockRuntime.serializeTerminalBuffer.mockResolvedValueOnce({
        cols: 80,
        rows: 24,
        lines: ['hello']
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handler returns snapshot structure
      const res = (await handlers.get('terminalPreview:connect')?.(
        { sender: satelliteSender },
        { ptyId: 'pty-1' }
      )) as { snapshot?: unknown }
      expect(res.snapshot).toBeDefined()
      expect(mockRuntime.serializeTerminalBuffer).toHaveBeenCalledWith('pty-1', expect.any(Object))
    })

    it('rejects malformed ptyId', async () => {
      const res = await handlers.get('terminalPreview:connect')?.(
        { sender: satelliteSender },
        { ptyId: '' }
      )
      expect(res).toEqual({ snapshot: null, replay: [] })
    })
  })

  describe('terminalPreview:fit', () => {
    it('rejects untrusted sender', async () => {
      const res = await handlers.get('terminalPreview:fit')?.(
        { sender: untrustedSender },
        { ptyId: 'pty-1', cols: 100, rows: 30 }
      )
      expect(res).toBeNull()
      expect(mockRuntime.updateRemoteDesktopViewer).not.toHaveBeenCalled()
    })

    it('accepts satellite sender and prefixes viewer key with workspace-popout', async () => {
      const res = await handlers.get('terminalPreview:fit')?.(
        { sender: satelliteSender },
        { ptyId: 'pty-1', cols: 100, rows: 30 }
      )
      expect(res).toEqual({ cols: 80, rows: 24 })
      expect(mockRuntime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
        'pty-1',
        'workspace-popout:2',
        'workspace-popout:2',
        100,
        30
      )
    })

    it('uses dashboard-popout prefix for dashboard sender', async () => {
      await handlers.get('terminalPreview:fit')?.(
        { sender: dashboardSender },
        { ptyId: 'pty-1', cols: 90, rows: 25 }
      )
      expect(mockRuntime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
        'pty-1',
        'dashboard-popout:3',
        'dashboard-popout:3',
        90,
        25
      )
    })
  })

  describe('terminalPreview:input', () => {
    it('rejects untrusted sender', () => {
      handlers.get('terminalPreview:input')?.(
        { sender: untrustedSender },
        { ptyId: 'pty-1', data: 'ls\n' }
      )
      expect(mockRuntime.writeTerminalPreviewInput).not.toHaveBeenCalled()
    })

    it('accepts satellite sender and relays input', () => {
      handlers.get('terminalPreview:input')?.(
        { sender: satelliteSender },
        { ptyId: 'pty-1', data: 'ls\n' }
      )
      expect(mockRuntime.writeTerminalPreviewInput).toHaveBeenCalledWith('pty-1', 'ls\n')
    })
  })

  describe('terminalPreview:unsubscribe', () => {
    it('ignores untrusted sender', () => {
      handlers.get('terminalPreview:unsubscribe')?.({ sender: untrustedSender }, { ptyId: 'pty-1' })
      expect(mockRuntime.unregisterRemoteDesktopViewer).not.toHaveBeenCalled()
    })

    it('accepts satellite sender and releases fit claim', async () => {
      // Fit first to register claim
      await handlers.get('terminalPreview:fit')?.(
        { sender: satelliteSender },
        { ptyId: 'pty-1', cols: 80, rows: 24 }
      )
      // Now unsubscribe
      handlers.get('terminalPreview:unsubscribe')?.({ sender: satelliteSender }, { ptyId: 'pty-1' })
      expect(mockRuntime.unregisterRemoteDesktopViewer).toHaveBeenCalledWith(
        'pty-1',
        'workspace-popout:2'
      )
    })
  })
})
