import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandCalls,
  getSendCommandMethods,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

// Native focus before insertion can blur the DOM.focus target; replay restores it.
describe('CdpWsProxy DOM.focus replay', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string

  beforeEach(async () => {
    mock = createMockWebContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {})
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('replays DOM.focus before Input.insertText in the root session', async () => {
    const client = await connect(endpoint)

    const focusResponse = await sendAndReceive(client, {
      id: 14,
      method: 'DOM.focus',
      params: { backendNodeId: 99 }
    })
    const insertResponse = await sendAndReceive(client, {
      id: 15,
      method: 'Input.insertText',
      params: { text: 'hello' }
    })

    expect(focusResponse.id).toBe(14)
    expect(insertResponse.id).toBe(15)
    expect(insertResponse.result).toEqual({})
    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(getSendCommandCalls(mock)).toEqual([
      ['Page.enable', {}],
      ['DOM.focus', { backendNodeId: 99 }],
      ['DOM.focus', { backendNodeId: 99 }],
      ['Input.insertText', { text: 'hello' }]
    ])
    client.close()
  })

  it('replays DOM.focus before Input.insertText for OOPIF sessions', async () => {
    const client = await connect(endpoint)

    await sendAndReceive(client, {
      id: 16,
      method: 'DOM.focus',
      params: { backendNodeId: 123 },
      sessionId: 'oopif-session-123'
    })
    const insertResponse = await sendAndReceive(client, {
      id: 17,
      method: 'Input.insertText',
      params: { text: 'frame text' },
      sessionId: 'oopif-session-123'
    })

    expect(insertResponse.id).toBe(17)
    expect(insertResponse.result).toEqual({})
    expect(getSendCommandCalls(mock)).toEqual([
      ['Page.enable', {}],
      ['DOM.focus', { backendNodeId: 123 }, 'oopif-session-123'],
      ['DOM.focus', { backendNodeId: 123 }, 'oopif-session-123'],
      ['Input.insertText', { text: 'frame text' }, 'oopif-session-123']
    ])
    client.close()
  })

  it('does not replay DOM.focus after adjacent eval traffic', async () => {
    const client = await connect(endpoint)

    await sendAndReceive(client, {
      id: 18,
      method: 'DOM.focus',
      params: { backendNodeId: 44 }
    })
    await sendAndReceive(client, {
      id: 19,
      method: 'Runtime.callFunctionOn',
      params: { functionDeclaration: '() => document.activeElement?.id' }
    })
    const insertResponse = await sendAndReceive(client, {
      id: 20,
      method: 'Input.insertText',
      params: { text: 'after eval' }
    })

    expect(insertResponse.id).toBe(20)
    expect(insertResponse.result).toEqual({})
    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(getSendCommandCalls(mock)).toEqual([
      ['Page.enable', {}],
      ['DOM.focus', { backendNodeId: 44 }],
      ['Runtime.callFunctionOn', { functionDeclaration: '() => document.activeElement?.id' }],
      ['Input.insertText', { text: 'after eval' }]
    ])
    client.close()
  })

  it('does not replay a failed DOM.focus on the next Input.insertText', async () => {
    let domFocusAttempt = 0
    mock.webContents.debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const [method] = args as [string]
      if (method === 'DOM.focus') {
        domFocusAttempt += 1
        if (domFocusAttempt === 1) {
          throw new Error('Node not found')
        }
      }
      return {}
    })

    const client = await connect(endpoint)

    const focusResponse = await sendAndReceive(client, {
      id: 21,
      method: 'DOM.focus',
      params: { backendNodeId: 55 }
    })
    const insertResponse = await sendAndReceive(client, {
      id: 22,
      method: 'Input.insertText',
      params: { text: 'fallback' }
    })

    expect(focusResponse).toEqual({
      id: 21,
      error: { code: -32000, message: 'Node not found' }
    })
    expect(insertResponse.id).toBe(22)
    expect(insertResponse.result).toEqual({})
    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(getSendCommandCalls(mock)).toEqual([
      ['Page.enable', {}],
      ['DOM.focus', { backendNodeId: 55 }],
      ['Input.insertText', { text: 'fallback' }]
    ])
    client.close()
  })

  it('returns the replay error when the stored DOM.focus fails before Input.insertText', async () => {
    let domFocusAttempt = 0
    mock.webContents.debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const [method] = args as [string]
      if (method === 'DOM.focus') {
        domFocusAttempt += 1
        if (domFocusAttempt === 2) {
          throw new Error('Focus target went stale')
        }
      }
      return {}
    })

    const client = await connect(endpoint)

    const focusResponse = await sendAndReceive(client, {
      id: 23,
      method: 'DOM.focus',
      params: { backendNodeId: 77 }
    })
    const insertResponse = await sendAndReceive(client, {
      id: 24,
      method: 'Input.insertText',
      params: { text: 'blocked' }
    })

    expect(focusResponse.id).toBe(23)
    expect(focusResponse.result).toEqual({})
    expect(insertResponse).toEqual({
      id: 24,
      error: { code: -32000, message: 'Focus target went stale' }
    })
    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(getSendCommandCalls(mock)).toEqual([
      ['Page.enable', {}],
      ['DOM.focus', { backendNodeId: 77 }],
      ['DOM.focus', { backendNodeId: 77 }]
    ])
    client.close()
  })

  it('still replays DOM.focus when Input.insertText is dispatched while DOM.focus is still in flight', async () => {
    let resolveFocus: (v: Record<string, unknown>) => void
    const focusPromise = new Promise<Record<string, unknown>>((r) => {
      resolveFocus = r
    })
    mock.webContents.debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const [method] = args as [string]
      if (method === 'DOM.focus') {
        return focusPromise
      }
      return {}
    })

    const client = await connect(endpoint)
    const responses: Record<string, unknown>[] = []
    client.on('message', (data) => {
      responses.push(JSON.parse(data.toString()))
    })

    client.send(JSON.stringify({ id: 25, method: 'DOM.focus', params: { backendNodeId: 66 } }))
    await new Promise((r) => setTimeout(r, 10))
    client.send(
      JSON.stringify({ id: 26, method: 'Input.insertText', params: { text: 'pipelined' } })
    )

    await new Promise((r) => setTimeout(r, 20))
    resolveFocus!({})
    await new Promise((r) => setTimeout(r, 20))

    expect(responses).toHaveLength(2)
    const focusResponse = responses.find((r) => r.id === 25)
    const insertResponse = responses.find((r) => r.id === 26)
    expect(focusResponse?.result).toEqual({})
    expect(insertResponse?.result).toEqual({})
    expect(getSendCommandMethods(mock)).toEqual([
      'Page.enable',
      'DOM.focus',
      'DOM.focus',
      'Input.insertText'
    ])
    client.close()
  })

  it('clears the pending DOM.focus replay when Page.bringToFront intervenes', async () => {
    const client = await connect(endpoint)

    await sendAndReceive(client, {
      id: 27,
      method: 'DOM.focus',
      params: { backendNodeId: 88 }
    })
    await sendAndReceive(client, { id: 28, method: 'Page.bringToFront', params: {} })
    const insertResponse = await sendAndReceive(client, {
      id: 29,
      method: 'Input.insertText',
      params: { text: 'no replay' }
    })

    expect(insertResponse.id).toBe(29)
    expect(insertResponse.result).toEqual({})
    // Only insertText focuses natively; bringToFront is a no-op.
    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    expect(getSendCommandMethods(mock)).toEqual(['Page.enable', 'DOM.focus', 'Input.insertText'])
    client.close()
  })

  it('clears the pending DOM.focus replay when Page.captureScreenshot intervenes', async () => {
    const client = await connect(endpoint)

    await sendAndReceive(client, {
      id: 30,
      method: 'DOM.focus',
      params: { backendNodeId: 91 }
    })
    await sendAndReceive(client, { id: 31, method: 'Page.captureScreenshot', params: {} })
    const insertResponse = await sendAndReceive(client, {
      id: 32,
      method: 'Input.insertText',
      params: { text: 'no replay after screenshot' }
    })

    expect(insertResponse.id).toBe(32)
    expect(insertResponse.result).toEqual({})
    expect(getSendCommandMethods(mock)).toEqual([
      'Page.enable',
      'DOM.focus',
      'Page.captureScreenshot',
      'Input.insertText'
    ])
    client.close()
  })

  it('does not replay a pending DOM.focus across a client reconnect', async () => {
    const first = await connect(endpoint)
    await sendAndReceive(first, { id: 33, method: 'DOM.focus', params: { backendNodeId: 12 } })
    first.close()

    const second = await connect(endpoint)
    const insertResponse = await sendAndReceive(second, {
      id: 34,
      method: 'Input.insertText',
      params: { text: 'fresh client' }
    })

    expect(insertResponse.id).toBe(34)
    expect(insertResponse.result).toEqual({})
    expect(getSendCommandMethods(mock)).toEqual(['Page.enable', 'DOM.focus', 'Input.insertText'])
    second.close()
  })

  it('does not replay or insert once the client disconnects mid-DOM.focus', async () => {
    let resolveFocus: (v: Record<string, unknown>) => void = () => {}
    mock.webContents.debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const [method] = args as [string]
      if (method === 'DOM.focus') {
        return new Promise<Record<string, unknown>>((resolve) => {
          resolveFocus = resolve
        })
      }
      return {}
    })

    const client = await connect(endpoint)
    client.send(JSON.stringify({ id: 35, method: 'DOM.focus', params: { backendNodeId: 7 } }))
    await new Promise((r) => setTimeout(r, 10))
    client.send(JSON.stringify({ id: 36, method: 'Input.insertText', params: { text: 'gone' } }))
    await new Promise((r) => setTimeout(r, 10))
    client.close()
    await new Promise((r) => setTimeout(r, 10))

    resolveFocus({})
    await new Promise((r) => setTimeout(r, 20))

    const methods = getSendCommandMethods(mock)
    expect(methods.filter((m) => m === 'DOM.focus')).toHaveLength(1)
    expect(methods).not.toContain('Input.insertText')
  })

  it('does not insert once the client disconnects during the DOM.focus replay', async () => {
    let domFocusCalls = 0
    let resolveReplay: (v: Record<string, unknown>) => void = () => {}
    mock.webContents.debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const [method] = args as [string]
      if (method === 'DOM.focus') {
        domFocusCalls += 1
        // Stall the replay, after the initial focus succeeds, to disconnect during it.
        if (domFocusCalls === 2) {
          return new Promise<Record<string, unknown>>((resolve) => {
            resolveReplay = resolve
          })
        }
      }
      return {}
    })

    const client = await connect(endpoint)
    await sendAndReceive(client, { id: 37, method: 'DOM.focus', params: { backendNodeId: 9 } })
    client.send(JSON.stringify({ id: 38, method: 'Input.insertText', params: { text: 'late' } }))
    await new Promise((r) => setTimeout(r, 10))
    client.close()
    await new Promise((r) => setTimeout(r, 10))
    resolveReplay({})
    await new Promise((r) => setTimeout(r, 20))

    expect(getSendCommandMethods(mock)).not.toContain('Input.insertText')
  })
})
