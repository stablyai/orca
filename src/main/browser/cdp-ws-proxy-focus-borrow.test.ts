import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

const electronMock = vi.hoisted(() => {
  const focusReplyListeners = new Set<(...args: unknown[]) => void>()
  return {
    replyFocusBorrow: (borrowId: number, focused: boolean): void => {
      for (const listener of focusReplyListeners) {
        listener({}, { borrowId, focused })
      }
    },
    ipcMain: {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        if (channel === 'browser:agentInputFocusReply') {
          focusReplyListeners.add(listener)
        }
      }),
      removeListener: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        focusReplyListeners.delete(listener)
      })
    }
  }
})

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    fromWebContents: vi.fn(() => null)
  },
  ipcMain: electronMock.ipcMain
}))

// Why: main cannot see whether the guest took focus — only the pane hosting it can.
// These tests pin what main does with each answer, because forwarding an input the
// guest never focused is exactly how agent keystrokes reach the user's window.
describe('CdpWsProxy agent input focus borrow', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string

  function answerBorrowWith(focused: boolean): void {
    mock.webContents.hostWebContents.send.mockImplementation((_channel, detail) => {
      if (detail.phase === 'begin') {
        electronMock.replyFocusBorrow(detail.borrowId, focused)
      }
    })
  }

  beforeEach(async () => {
    mock = createMockWebContents()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxy = new CdpWsProxy(mock.webContents as any)
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('forwards a key event once the pane grants focus', async () => {
    answerBorrowWith(true)
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 90,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'a' }
    })

    expect(response.error).toBeUndefined()
    expect(getSendCommandMethods(mock)).toContain('Input.dispatchKeyEvent')
    client.close()
  })

  // Why: a guest can refuse focus while staying alive — a hidden or detached pane still
  // answers CDP. Forwarding then puts the keystroke wherever the user is typing, so the
  // command has to fail instead of reporting a success that landed somewhere else.
  it('fails a key event the pane could not focus', async () => {
    answerBorrowWith(false)
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 91,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'a' }
    })

    expect((response.error as { message: string }).message).toContain('keyboard focus')
    expect(getSendCommandMethods(mock)).not.toContain('Input.dispatchKeyEvent')
    // Why: the pane counted the begin, so it still needs the end to unwind it.
    expect(mock.webContents.hostWebContents.send).toHaveBeenCalledWith(
      'ui:browserAgentInput',
      expect.objectContaining({ phase: 'end' })
    )
    client.close()
  })

  it('fails Input.insertText the pane could not focus', async () => {
    answerBorrowWith(false)
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 92,
      method: 'Input.insertText',
      params: { text: 'hello' }
    })

    expect((response.error as { message: string }).message).toContain('keyboard focus')
    expect(getSendCommandMethods(mock)).not.toContain('Input.insertText')
    client.close()
  })

  // Why: no pane hosts this guest, so nobody answers. Dropping the input there would
  // break offscreen and not-yet-mounted guests that worked before the handoff existed.
  it('forwards input when no pane answers the borrow', async () => {
    mock.webContents.hostWebContents.send.mockImplementation(() => {})
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 93,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'a' }
    })

    expect(response.error).toBeUndefined()
    expect(getSendCommandMethods(mock)).toContain('Input.dispatchKeyEvent')
    client.close()
  })

  it('forwards input without asking when the guest has no host renderer', async () => {
    mock.webContents.hostWebContents.isDestroyed.mockReturnValue(true)
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 94,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'a' }
    })

    expect(response.error).toBeUndefined()
    expect(mock.webContents.hostWebContents.send).not.toHaveBeenCalled()
    expect(getSendCommandMethods(mock)).toContain('Input.dispatchKeyEvent')
    client.close()
  })
})
