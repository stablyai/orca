import type { BrowserWindow, ipcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  broadcastA2ALink,
  registerTerminalA2AHandlers,
  TERMINAL_A2A_LINK_CHANNEL
} from './terminal-a2a'
import type { A2ALinkEvent } from '../../shared/terminal-a2a-link'

describe('terminal-a2a IPC', () => {
  it('broadcasts A2A link event to all non-destroyed windows', () => {
    const sendMock1 = vi.fn()
    const sendMock2 = vi.fn()
    const mockWindow1 = {
      isDestroyed: () => false,
      webContents: { send: sendMock1 }
    } as unknown as BrowserWindow
    const mockWindow2 = {
      isDestroyed: () => true,
      webContents: { send: sendMock2 }
    } as unknown as BrowserWindow

    const testEvent: A2ALinkEvent = {
      id: 'test-1',
      from: '@2',
      to: '@5',
      fromIndex: 2,
      toIndex: 5,
      type: 'send',
      text: 'npm test',
      timestamp: Date.now()
    }

    broadcastA2ALink(testEvent, {
      getWindows: () => [mockWindow1, mockWindow2]
    })

    expect(sendMock1).toHaveBeenCalledWith(TERMINAL_A2A_LINK_CHANNEL, testEvent)
    expect(sendMock2).not.toHaveBeenCalled()
  })

  it('registers ipc handler and invokes broadcast on call', async () => {
    const handleMock = vi.fn()
    const mockIpc = { handle: handleMock } as unknown as typeof ipcMain
    const sendMock = vi.fn()
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: sendMock }
    } as unknown as BrowserWindow

    registerTerminalA2AHandlers({
      ipc: mockIpc,
      getWindows: () => [mockWindow]
    })

    expect(handleMock).toHaveBeenCalledWith(TERMINAL_A2A_LINK_CHANNEL, expect.any(Function))
    const handler = handleMock.mock.calls[0][1]

    const testEvent: A2ALinkEvent = {
      id: 'test-2',
      from: '@2',
      to: '@8',
      fromIndex: 2,
      toIndex: 8,
      type: 'message',
      text: 'review please',
      timestamp: Date.now()
    }

    const res = await handler({}, testEvent)
    expect(res.ok).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      TERMINAL_A2A_LINK_CHANNEL,
      expect.objectContaining({ id: 'test-2', from: '@2', to: '@8' })
    )
  })

  it('dispatches to terminal PTY when runtime is supplied to IPC handler', async () => {
    const handleMock = vi.fn()
    const mockIpc = { handle: handleMock } as unknown as typeof ipcMain
    const sendMock = vi.fn()
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: sendMock }
    } as unknown as BrowserWindow

    const mockSendTerminal = vi.fn().mockResolvedValue({
      send: { accepted: true, bytesWritten: 8 }
    })
    const mockRuntime = {
      listTerminals: vi.fn().mockResolvedValue({
        terminals: [{ handle: 'term-3', index: 3 }]
      }),
      sendTerminal: mockSendTerminal
    }

    registerTerminalA2AHandlers({
      ipc: mockIpc,
      getWindows: () => [mockWindow],
      getRuntime: () => mockRuntime
    })

    const handler = handleMock.mock.calls[0][1]
    const testEvent: A2ALinkEvent = {
      id: 'test-3',
      from: '@1',
      to: '@3',
      fromIndex: 1,
      toIndex: 3,
      type: 'send',
      text: 'git status',
      timestamp: Date.now()
    }

    const res = await handler({}, testEvent)
    expect(res.ok).toBe(true)
    expect(res.delivered).toBe(true)
    expect(res.targetHandle).toBe('term-3')
    expect(mockSendTerminal).toHaveBeenCalledWith(
      'term-3',
      expect.objectContaining({ text: 'git status', enter: true })
    )
  })
})
