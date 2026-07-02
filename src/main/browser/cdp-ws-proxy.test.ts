import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

type DebuggerListener = (...args: unknown[]) => void

function createMockWebContents() {
  const listeners = new Map<string, DebuggerListener[]>()
  let debuggerAttached = false
  let destroyed = false

  const debuggerObj = {
    isAttached: vi.fn(() => debuggerAttached),
    attach: vi.fn(() => {
      debuggerAttached = true
    }),
    detach: vi.fn(() => {
      debuggerAttached = false
    }),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      arr.push(handler)
      listeners.set(event, arr)
    }),
    removeListener: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      listeners.set(
        event,
        arr.filter((h) => h !== handler)
      )
    })
  }

  return {
    webContents: {
      debugger: debuggerObj,
      isDestroyed: () => destroyed,
      focus: vi.fn(),
      printToPDF: vi.fn(async () => Buffer.from('%PDF-test')),
      getTitle: vi.fn(() => 'Example'),
      getURL: vi.fn(() => 'https://example.com')
    },
    listeners,
    destroy() {
      destroyed = true
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args)
      }
    }
  }
}

describe('CdpWsProxy', () => {
  let mock: ReturnType<typeof createMockWebContents>
  let proxy: CdpWsProxy
  let endpoint: string

  beforeEach(async () => {
    mock = createMockWebContents()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxy = new CdpWsProxy(mock.webContents as any)
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  function connect(): Promise<WebSocket> {
    return new Promise((resolve) => {
      const ws = new WebSocket(endpoint)
      ws.on('open', () => resolve(ws))
    })
  }

  function sendAndReceive(
    ws: WebSocket,
    msg: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify(msg))
    })
  }

  function expectPdfStreamHandle(response: Record<string, unknown>): string {
    const result = response.result as Record<string, unknown>
    expect(result.data).toBe('')
    expect(result.stream).toEqual(expect.stringMatching(/^orca-pdf-[\da-f-]{36}-\d+$/))
    return result.stream as string
  }

  const defaultPdfMarginInches = 1 / 2.54

  it('starts on a random port and returns ws:// URL', () => {
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(proxy.getPort()).toBeGreaterThan(0)
  })

  it('does not retain an extra startup server error listener after binding', () => {
    const server = (
      proxy as unknown as { httpServer: { listenerCount: (event: string) => number } }
    ).httpServer

    expect(server.listenerCount('error')).toBeLessThanOrEqual(1)
  })

  it('attaches debugger on start', () => {
    expect(mock.webContents.debugger.attach).toHaveBeenCalledWith('1.3')
  })

  // ── CDP message ID correlation ──

  it('correlates CDP request/response IDs', async () => {
    mock.webContents.debugger.sendCommand.mockResolvedValueOnce({ tree: 'nodes' })

    const ws = connect()
    const client = await ws
    const response = await sendAndReceive(client, {
      id: 42,
      method: 'Accessibility.getFullAXTree',
      params: {}
    })

    expect(response.id).toBe(42)
    expect(response.result).toEqual({ tree: 'nodes' })
    client.close()
  })

  it('returns error response when sendCommand fails', async () => {
    mock.webContents.debugger.sendCommand.mockRejectedValueOnce(new Error('Node not found'))

    const client = await connect()
    const response = await sendAndReceive(client, {
      id: 7,
      method: 'DOM.describeNode',
      params: { nodeId: 999 }
    })

    expect(response.id).toBe(7)
    expect(response.error).toEqual({ code: -32000, message: 'Node not found' })
    client.close()
  })

  it('returns an error instead of crashing when a command arrives after tab destruction', async () => {
    const client = await connect()
    mock.destroy()

    const response = await sendAndReceive(client, {
      id: 8,
      method: 'Runtime.evaluate',
      params: { expression: 'location.href' }
    })

    expect(response.id).toBe(8)
    expect(response.error).toEqual({
      code: -32000,
      message: 'Browser tab is no longer available'
    })
    expect(mock.webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.anything(),
      expect.anything()
    )
    client.close()
  })

  // ── Concurrent requests get correct responses ──

  it('handles concurrent requests with correct correlation', async () => {
    let resolveFirst: (v: unknown) => void
    const firstPromise = new Promise((r) => {
      resolveFirst = r
    })

    mock.webContents.debugger.sendCommand
      .mockImplementationOnce(async () => {
        await firstPromise
        return { result: 'slow' }
      })
      .mockResolvedValueOnce({ result: 'fast' })

    const client = await connect()

    const responses: Record<string, unknown>[] = []
    client.on('message', (data) => {
      responses.push(JSON.parse(data.toString()))
    })

    client.send(JSON.stringify({ id: 1, method: 'DOM.enable', params: {} }))
    await new Promise((r) => setTimeout(r, 10))
    client.send(JSON.stringify({ id: 2, method: 'Page.enable', params: {} }))

    await new Promise((r) => setTimeout(r, 20))
    resolveFirst!(undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(responses).toHaveLength(2)
    const resp1 = responses.find((r) => r.id === 1)
    const resp2 = responses.find((r) => r.id === 2)
    expect(resp1?.result).toEqual({ result: 'slow' })
    expect(resp2?.result).toEqual({ result: 'fast' })

    client.close()
  })

  it('does not deliver a late response from a closed client to a newer websocket', async () => {
    let resolveSlowCommand: ((value: { result: string }) => void) | null = null
    mock.webContents.debugger.sendCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlowCommand = resolve
          })
      )
      .mockResolvedValueOnce({ result: 'new-client' })

    const firstClient = await connect()
    firstClient.send(JSON.stringify({ id: 1, method: 'DOM.enable', params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const secondClient = await connect()
    const responses: Record<string, unknown>[] = []
    secondClient.on('message', (data) => {
      responses.push(JSON.parse(data.toString()))
    })

    secondClient.send(JSON.stringify({ id: 2, method: 'Page.enable', params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    resolveSlowCommand!({ result: 'old-client' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(responses).toEqual([{ id: 2, result: { result: 'new-client' } }])

    secondClient.close()
  })

  // ── sessionId envelope translation ──

  it('forwards sessionId to sendCommand for OOPIF support', async () => {
    mock.webContents.debugger.sendCommand.mockResolvedValueOnce({})

    const client = await connect()
    await sendAndReceive(client, {
      id: 1,
      method: 'DOM.enable',
      params: {},
      sessionId: 'oopif-session-123'
    })

    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'DOM.enable',
      {},
      'oopif-session-123'
    )
    client.close()
  })

  // ── Event forwarding ──

  it('forwards CDP events from debugger to client', async () => {
    const client = await connect()

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      client.on('message', (data) => resolve(JSON.parse(data.toString())))
    })

    mock.emit('message', {}, 'Console.messageAdded', { entry: { text: 'hello' } })

    const event = await eventPromise
    expect(event.method).toBe('Console.messageAdded')
    expect(event.params).toEqual({ entry: { text: 'hello' } })
    client.close()
  })

  it('forwards sessionId in events when present', async () => {
    const client = await connect()

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      client.on('message', (data) => resolve(JSON.parse(data.toString())))
    })

    mock.emit('message', {}, 'DOM.nodeInserted', { node: {} }, 'iframe-session-456')

    const event = await eventPromise
    expect(event.sessionId).toBe('iframe-session-456')
    client.close()
  })

  it('does not focus the guest for Runtime.evaluate polling commands', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 9,
      method: 'Runtime.evaluate',
      params: { expression: 'document.readyState' }
    })

    expect(mock.webContents.focus).not.toHaveBeenCalled()
    client.close()
  })

  it('still focuses the guest for Input.insertText', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 10,
      method: 'Input.insertText',
      params: { text: 'hello' }
    })

    expect(mock.webContents.focus).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('prints PDF data through native webContents printToPDF', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 11,
      method: 'Page.printToPDF',
      params: {
        landscape: true,
        printBackground: true,
        paperWidth: 8.5,
        paperHeight: 11,
        marginTop: 0.25,
        marginBottom: 0.5,
        marginLeft: 0.75,
        marginRight: 1,
        pageRanges: '1-2',
        preferCSSPageSize: true
      }
    })

    expect(response).toEqual({
      id: 11,
      result: { data: Buffer.from('%PDF-test').toString('base64') }
    })
    expect(mock.webContents.printToPDF).toHaveBeenCalledWith({
      landscape: true,
      printBackground: true,
      pageSize: { width: 8.5, height: 11 },
      margins: {
        marginType: 'custom',
        top: 0.25,
        bottom: 0.5,
        left: 0.75,
        right: 1
      },
      pageRanges: '1-2',
      preferCSSPageSize: true
    })
    const forwardedMethods = mock.webContents.debugger.sendCommand.mock.calls.map(
      (call) => (call as unknown[])[0]
    )
    expect(forwardedMethods).not.toContain('Page.printToPDF')
    client.close()
  })

  it('keeps default PDF margins for omitted sides', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 12,
      method: 'Page.printToPDF',
      params: {
        marginTop: 0.25
      }
    })

    expect(mock.webContents.printToPDF).toHaveBeenCalledWith({
      margins: {
        marginType: 'custom',
        top: 0.25,
        bottom: defaultPdfMarginInches,
        left: defaultPdfMarginInches,
        right: defaultPdfMarginInches
      }
    })
    client.close()
  })

  it('supports streamed Page.printToPDF results for Playwright page.pdf', async () => {
    mock.webContents.printToPDF.mockResolvedValueOnce(Buffer.from('abcdef'))
    const client = await connect()

    const printResponse = await sendAndReceive(client, {
      id: 12,
      method: 'Page.printToPDF',
      params: { transferMode: 'ReturnAsStream' }
    })
    const handle = expectPdfStreamHandle(printResponse)

    const firstRead = await sendAndReceive(client, {
      id: 13,
      method: 'IO.read',
      params: { handle, size: 2 }
    })
    const secondRead = await sendAndReceive(client, {
      id: 14,
      method: 'IO.read',
      params: { handle }
    })
    const closeResponse = await sendAndReceive(client, {
      id: 15,
      method: 'IO.close',
      params: { handle }
    })
    const readAfterClose = await sendAndReceive(client, {
      id: 16,
      method: 'IO.read',
      params: { handle }
    })

    expect(printResponse.id).toBe(12)
    expect(firstRead).toEqual({
      id: 13,
      result: { base64Encoded: true, data: Buffer.from('ab').toString('base64'), eof: false }
    })
    expect(secondRead).toEqual({
      id: 14,
      result: { base64Encoded: true, data: Buffer.from('cdef').toString('base64'), eof: true }
    })
    expect(closeResponse).toEqual({ id: 15, result: {} })
    expect(readAfterClose).toEqual({
      id: 16,
      error: { code: -32000, message: 'Invalid stream handle' }
    })
    client.close()
  })

  it('clears streamed PDF data when the client disconnects', async () => {
    mock.webContents.printToPDF.mockResolvedValueOnce(Buffer.from('abcdef'))
    const client = await connect()

    const printResponse = await sendAndReceive(client, {
      id: 16,
      method: 'Page.printToPDF',
      params: { transferMode: 'ReturnAsStream' }
    })
    const handle = expectPdfStreamHandle(printResponse)

    expect(printResponse.id).toBe(16)
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const nextClient = await connect()
    const staleRead = await sendAndReceive(nextClient, {
      id: 17,
      method: 'IO.read',
      params: { handle }
    })

    expect(staleRead).toEqual({
      id: 17,
      error: { code: -32000, message: 'Invalid stream handle' }
    })
    nextClient.close()
  })

  it('forwards non-PDF IO streams to the debugger', async () => {
    mock.webContents.debugger.sendCommand
      .mockResolvedValueOnce({ data: 'trace-data', eof: false })
      .mockResolvedValueOnce({})
    const client = await connect()

    const readResponse = await sendAndReceive(client, {
      id: 18,
      method: 'IO.read',
      params: { handle: 'trace-stream', size: 64 }
    })
    const closeResponse = await sendAndReceive(client, {
      id: 19,
      method: 'IO.close',
      params: { handle: 'trace-stream' }
    })

    expect(readResponse).toEqual({ id: 18, result: { data: 'trace-data', eof: false } })
    expect(closeResponse).toEqual({ id: 19, result: {} })
    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'IO.read',
      { handle: 'trace-stream', size: 64 },
      undefined
    )
    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'IO.close',
      { handle: 'trace-stream' },
      undefined
    )
    client.close()
  })

  // ── Page.frameNavigated interception ──

  // ── Cleanup ──

  it('detaches debugger and closes server on stop', async () => {
    const client = await connect()
    await proxy.stop()

    expect(mock.webContents.debugger.detach).toHaveBeenCalled()
    expect(proxy.getPort()).toBeGreaterThan(0) // port stays set but server is closed

    await new Promise<void>((resolve) => {
      client.on('close', () => resolve())
      if (client.readyState === WebSocket.CLOSED) {
        resolve()
      }
    })
  })

  it('detaches client websocket listeners after client close', async () => {
    const client = await connect()
    const serverClient = (proxy as unknown as { client: WebSocket | null }).client
    expect(serverClient).toBeTruthy()
    const offSpy = vi.spyOn(serverClient!, 'off')

    client.close()

    const start = Date.now()
    while (
      (proxy as unknown as { client: WebSocket | null }).client &&
      Date.now() - start < 2_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect((proxy as unknown as { client: WebSocket | null }).client).toBeNull()
    const removedEvents = offSpy.mock.calls.map(([event]) => event)
    expect(removedEvents).toEqual(expect.arrayContaining(['message', 'close']))
    offSpy.mockRestore()
  })

  it('rejects inflight requests on stop', async () => {
    let resolveCommand: (v: unknown) => void
    mock.webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise((r) => {
          resolveCommand = r as (v: unknown) => void
        })
    )

    const client = await connect()
    client.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }))

    await new Promise((r) => setTimeout(r, 10))
    await proxy.stop()

    resolveCommand!({})
    client.close()
  })
})
