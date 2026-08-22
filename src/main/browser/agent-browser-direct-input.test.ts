import { beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireElectronDebuggerMock, releaseMock } = vi.hoisted(() => ({
  acquireElectronDebuggerMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: acquireElectronDebuggerMock
}))

import { AgentBrowserDirectInput } from './agent-browser-direct-input'

describe('AgentBrowserDirectInput', () => {
  const sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}))
  const focus = vi.fn()
  const wc = { debugger: { sendCommand }, focus }

  beforeEach(() => {
    vi.clearAllMocks()
    acquireElectronDebuggerMock.mockReturnValue({ release: releaseMock })
  })

  it('preserves pointer coordinates and button state across direct CDP commands', async () => {
    const input = new AgentBrowserDirectInput()

    await input.move('page-1', wc as never, 12, 34)
    await input.down('page-1', wc as never, 'left')
    await input.move('page-1', wc as never, 56, 78)
    await input.up('page-1', wc as never, 'left')
    await input.wheel('page-1', wc as never, 120, -4)

    expect(sendCommand.mock.calls.map((call) => call[1])).toEqual([
      { type: 'mouseMoved', x: 12, y: 34, buttons: 0 },
      { type: 'mousePressed', x: 12, y: 34, buttons: 1, button: 'left', clickCount: 1 },
      { type: 'mouseMoved', x: 56, y: 78, buttons: 1 },
      { type: 'mouseReleased', x: 56, y: 78, buttons: 0, button: 'left', clickCount: 1 },
      { type: 'mouseWheel', x: 56, y: 78, buttons: 0, deltaX: -4, deltaY: 120 }
    ])
    expect(releaseMock).toHaveBeenCalledTimes(5)
  })

  it('forgets pointer state when a page closes or swaps process', async () => {
    const input = new AgentBrowserDirectInput()
    await input.move('page-1', wc as never, 12, 34)
    input.forget('page-1')

    await input.wheel('page-1', wc as never, 10)

    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 0,
      y: 0,
      buttons: 0,
      deltaX: 0,
      deltaY: 10
    })
  })

  it('does not restore pointer state from input that finishes after page teardown', async () => {
    const input = new AgentBrowserDirectInput()
    let releaseFirstMove: (() => void) | null = null
    sendCommand.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseFirstMove = () => resolve({})
        })
    )

    const staleMove = input.move('page-1', wc as never, 12, 34)
    await vi.waitFor(() => expect(releaseFirstMove).not.toBeNull())
    input.forget('page-1')
    await input.move('page-1', wc as never, 56, 78)
    releaseFirstMove!()
    await staleMove
    await input.wheel('page-1', wc as never, 10)

    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 56,
      y: 78,
      buttons: 0,
      deltaX: 0,
      deltaY: 10
    })
  })

  it('dispatches key down and up through the same debugger lease', async () => {
    const input = new AgentBrowserDirectInput()

    await input.keypress(wc as never, 'Control+Shift+r')

    expect(sendCommand).toHaveBeenNthCalledWith(
      1,
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'r', modifiers: 10 })
    )
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', key: 'r', modifiers: 10 })
    )
    expect(releaseMock).toHaveBeenCalledOnce()
  })
})
