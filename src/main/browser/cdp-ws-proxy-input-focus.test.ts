import { describe, it, expect, vi } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandCalls,
  getSendCommandMethods,
  mockAsWebContents,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpWsProxy agent input focus guard', () => {
  it('guards the user’s focus around a press and keeps the release behind it', async () => {
    let ready = (): void => {}
    const release = vi.fn()
    const guardFocus = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          ready = () => resolve(release)
        })
    )
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')
    const proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {}, guardFocus)
    const client = await connect(await proxy.start())
    mock.webContents.debugger.sendCommand.mockClear()
    const replies: unknown[] = []
    const bothReplied = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        replies.push(JSON.parse(data.toString()).id)
        if (replies.length === 2) {
          resolve()
        }
      })
    })

    for (const [id, type] of [
      [41, 'mousePressed'],
      [42, 'mouseReleased']
    ] as const) {
      client.send(
        JSON.stringify({ id, method: 'Input.dispatchMouseEvent', params: { type, x: 1, y: 1 } })
      )
    }
    await vi.waitFor(() => expect(guardFocus).toHaveBeenCalledTimes(1))
    // Emulate focus first; await pane readiness before pressing.
    expect(getSendCommandMethods(mock)).toEqual(['Emulation.setFocusEmulationEnabled'])
    ready()
    await bothReplied

    expect(replies).toEqual([41, 42])
    expect(release).toHaveBeenCalledTimes(1)
    expect(guardFocus).toHaveBeenCalledTimes(1)
    expect(mock.webContents.focus).not.toHaveBeenCalled()
    expect(getSendCommandCalls(mock).map(([method, params]) => params?.type ?? method)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'mousePressed',
      'mouseReleased'
    ])
    client.close()
    await proxy.stop()
  })

  it('borrows focus for root-session IME composition and gives it back', async () => {
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')
    const release = vi.fn()
    const proxy = new CdpWsProxy(
      mockAsWebContents(mock),
      () => () => {},
      async () => release
    )
    const client = await connect(await proxy.start())

    await sendAndReceive(client, {
      id: 51,
      method: 'Input.imeSetComposition',
      params: { text: 'に', selectionStart: 1, selectionEnd: 1 }
    })

    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(getSendCommandMethods(mock).slice(1)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Input.imeSetComposition'
    ])
    client.close()
    await proxy.stop()
  })

  it('forwards presses on pages outside an Orca window without a guard', async () => {
    const mock = createMockWebContents()
    const guardFocus = vi.fn(async () => () => {})
    const proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {}, guardFocus)
    const client = await connect(await proxy.start())

    await sendAndReceive(client, {
      id: 61,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 1 }
    })

    expect(guardFocus).not.toHaveBeenCalled()
    expect(getSendCommandMethods(mock).slice(1)).toEqual(['Input.dispatchMouseEvent'])
    client.close()
    await proxy.stop()
  })

  it('gives borrowed focus back when a text insert is abandoned at its DOM.focus replay', async () => {
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')
    let domFocusCalls = 0
    mock.webContents.debugger.sendCommand.mockImplementation(async (method?: string) => {
      if (method === 'DOM.focus' && ++domFocusCalls === 2) {
        throw new Error('Node is detached from document')
      }
      return {}
    })
    const release = vi.fn()
    const proxy = new CdpWsProxy(
      mockAsWebContents(mock),
      () => () => {},
      async () => release
    )
    const client = await connect(await proxy.start())

    await sendAndReceive(client, { id: 71, method: 'DOM.focus', params: { backendNodeId: 3 } })
    const insert = await sendAndReceive(client, {
      id: 72,
      method: 'Input.insertText',
      params: { text: 'a\nb' }
    })

    expect(insert.error).toBeDefined()
    expect(release).toHaveBeenCalledTimes(1)
    client.close()
    await proxy.stop()
  })

  it('refuses a press when the user’s focus cannot be guarded', async () => {
    const mock = createMockWebContents()
    mock.webContents.getType.mockReturnValue('webview')
    const proxy = new CdpWsProxy(
      mockAsWebContents(mock),
      () => () => {},
      async () => {
        throw new Error('focus guard unavailable')
      }
    )
    const client = await connect(await proxy.start())

    const response = await sendAndReceive(client, {
      id: 81,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 1 }
    })

    expect(response.error).toMatchObject({ message: 'focus guard unavailable' })
    expect(getSendCommandMethods(mock)).not.toContain('Input.dispatchMouseEvent')
    client.close()
    await proxy.stop()
  })
})
