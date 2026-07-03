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
    sendCommand: vi.fn(
      async (_method?: string, _params?: Record<string, unknown>, _sessionId?: string) => ({})
    ),
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
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
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

  type SendCommandCall = [string, Record<string, unknown>?, string?]

  function getSendCommandCalls(): SendCommandCall[] {
    const calls = mock.webContents.debugger.sendCommand.mock.calls as unknown as [
      string,
      Record<string, unknown>?,
      string?
    ][]
    return calls
  }

  function getSendCommandMethods(): string[] {
    const calls = getSendCommandCalls()
    return calls.map((call) => call[0])
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

  it('primes lifecycle events for Page.navigate', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 11,
      method: 'Page.navigate',
      params: { url: 'https://example.com/next' }
    })

    expect(response.id).toBe(11)
    expect(response.result).toEqual({})
    expect(getSendCommandMethods()).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Network.enable',
      'Page.enable',
      'Page.setLifecycleEventsEnabled',
      'Page.navigate'
    ])
    client.close()
  })

  it('primes lifecycle events for Page.reload and preserves response id', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 12,
      method: 'Page.reload'
    })

    expect(response.id).toBe(12)
    expect(response.result).toEqual({})
    expect(getSendCommandMethods()).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Network.enable',
      'Page.enable',
      'Page.setLifecycleEventsEnabled'
    ])
    expect(mock.webContents.reload).toHaveBeenCalledTimes(1)
    expect(getSendCommandMethods()).not.toContain('Page.reload')
    client.close()
  })

  it('preserves explicit Page.navigate session during lifecycle priming', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 14,
      method: 'Page.navigate',
      params: { url: 'https://example.com/frame' },
      sessionId: 'iframe-session-123'
    })

    expect(getSendCommandCalls().slice(2)).toEqual([
      ['Network.enable', {}, 'iframe-session-123'],
      ['Page.enable', {}, 'iframe-session-123'],
      ['Page.setLifecycleEventsEnabled', { enabled: true }, 'iframe-session-123'],
      ['Page.navigate', { url: 'https://example.com/frame' }, 'iframe-session-123']
    ])
    client.close()
  })

  it('forwards explicit Page.reload session after lifecycle priming', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 15,
      method: 'Page.reload',
      params: { ignoreCache: true },
      sessionId: 'iframe-session-123'
    })

    expect(getSendCommandCalls().slice(2)).toEqual([
      ['Network.enable', {}, 'iframe-session-123'],
      ['Page.enable', {}, 'iframe-session-123'],
      ['Page.setLifecycleEventsEnabled', { enabled: true }, 'iframe-session-123'],
      ['Page.reload', { ignoreCache: true }, 'iframe-session-123']
    ])
    expect(mock.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(mock.webContents.reload).not.toHaveBeenCalled()
    client.close()
  })

  it('rejects root Page.reload params that direct webContents reload cannot honor', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 16,
      method: 'Page.reload',
      params: { loaderId: 'stale-loader' }
    })

    expect(response).toEqual({
      id: 16,
      error: {
        code: -32000,
        message: 'Page.reload parameter "loaderId" is not supported for Orca tab reloads'
      }
    })
    expect(mock.webContents.reload).not.toHaveBeenCalled()
    expect(mock.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(getSendCommandMethods()).not.toContain('Network.enable')
    client.close()
  })

  it('still reloads when lifecycle priming stalls', async () => {
    const client = await connect()
    mock.webContents.debugger.sendCommand.mockImplementation((method?: string) => {
      if (method === 'Network.enable') {
        return new Promise(() => {})
      }
      return Promise.resolve({})
    })

    const responsePromise = sendAndReceive(client, {
      id: 17,
      method: 'Page.reload'
    })

    await expect(responsePromise).resolves.toEqual({ id: 17, result: {} })
    expect(mock.webContents.reload).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('does not reload after the requesting client disconnects during priming', async () => {
    const client = await connect()
    mock.webContents.debugger.sendCommand.mockImplementation((method?: string) => {
      if (method === 'Network.enable') {
        return new Promise(() => {})
      }
      return Promise.resolve({})
    })

    client.send(JSON.stringify({ id: 18, method: 'Page.reload' }))
    client.close()

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(mock.webContents.reload).not.toHaveBeenCalled()
    expect(mock.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('forwards Runtime.evaluate without lifecycle priming', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 13,
      method: 'Runtime.evaluate',
      params: { expression: 'document.readyState' }
    })

    expect(response.id).toBe(13)
    expect(response.result).toEqual({})
    expect(getSendCommandMethods()).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate'
    ])
    client.close()
  })

  it('prints PDF data through native webContents printToPDF', async () => {
    const client = await connect()

    const response = await sendAndReceive(client, {
      id: 19,
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
      id: 19,
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
    expect(getSendCommandMethods()).not.toContain('Page.printToPDF')
    client.close()
  })

  it('keeps default PDF margins for omitted sides', async () => {
    const client = await connect()

    await sendAndReceive(client, {
      id: 20,
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
      id: 21,
      method: 'Page.printToPDF',
      params: { transferMode: 'ReturnAsStream' }
    })
    const handle = expectPdfStreamHandle(printResponse)

    const firstRead = await sendAndReceive(client, {
      id: 22,
      method: 'IO.read',
      params: { handle, size: 2 }
    })
    const secondRead = await sendAndReceive(client, {
      id: 23,
      method: 'IO.read',
      params: { handle }
    })
    const closeResponse = await sendAndReceive(client, {
      id: 24,
      method: 'IO.close',
      params: { handle }
    })
    const readAfterClose = await sendAndReceive(client, {
      id: 25,
      method: 'IO.read',
      params: { handle }
    })

    expect(printResponse.id).toBe(21)
    expect(firstRead).toEqual({
      id: 22,
      result: { base64Encoded: true, data: Buffer.from('ab').toString('base64'), eof: false }
    })
    expect(secondRead).toEqual({
      id: 23,
      result: { base64Encoded: true, data: Buffer.from('cdef').toString('base64'), eof: true }
    })
    expect(closeResponse).toEqual({ id: 24, result: {} })
    expect(readAfterClose).toEqual({
      id: 25,
      error: { code: -32000, message: 'Invalid stream handle' }
    })
    client.close()
  })

  it('clears streamed PDF data when the client disconnects', async () => {
    mock.webContents.printToPDF.mockResolvedValueOnce(Buffer.from('abcdef'))
    const client = await connect()

    const printResponse = await sendAndReceive(client, {
      id: 26,
      method: 'Page.printToPDF',
      params: { transferMode: 'ReturnAsStream' }
    })
    const handle = expectPdfStreamHandle(printResponse)

    expect(printResponse.id).toBe(26)
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const nextClient = await connect()
    const staleRead = await sendAndReceive(nextClient, {
      id: 27,
      method: 'IO.read',
      params: { handle }
    })

    expect(staleRead).toEqual({
      id: 27,
      error: { code: -32000, message: 'Invalid stream handle' }
    })
    nextClient.close()
  })

  it('does not register a PDF stream when the client disconnects mid-print', async () => {
    let resolvePrint: (buf: Buffer) => void = () => {}
    mock.webContents.printToPDF.mockImplementationOnce(
      () =>
        new Promise<Buffer>((resolve) => {
          resolvePrint = resolve
        })
    )
    const store = (proxy as unknown as { pdfStreams: { create: (b: Buffer) => string } }).pdfStreams
    const createSpy = vi.spyOn(store, 'create')

    const client = await connect()
    client.send(
      JSON.stringify({
        id: 30,
        method: 'Page.printToPDF',
        params: { transferMode: 'ReturnAsStream' }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Print resolves only after the client is gone: no stream must be created.
    resolvePrint(Buffer.from('%PDF-late'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('forwards non-PDF IO streams to the debugger', async () => {
    mock.webContents.debugger.sendCommand
      .mockResolvedValueOnce({ data: 'trace-data', eof: false })
      .mockResolvedValueOnce({})
    const client = await connect()

    const readResponse = await sendAndReceive(client, {
      id: 28,
      method: 'IO.read',
      params: { handle: 'trace-stream', size: 64 }
    })
    const closeResponse = await sendAndReceive(client, {
      id: 29,
      method: 'IO.close',
      params: { handle: 'trace-stream' }
    })

    expect(readResponse).toEqual({ id: 28, result: { data: 'trace-data', eof: false } })
    expect(closeResponse).toEqual({ id: 29, result: {} })
    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith('IO.read', {
      handle: 'trace-stream',
      size: 64
    })
    expect(mock.webContents.debugger.sendCommand).toHaveBeenCalledWith('IO.close', {
      handle: 'trace-stream'
    })
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
