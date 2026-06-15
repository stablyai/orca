import { describe, it, expect, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import { startIdeServer, type IdeServer } from './ide-server'
import { handleToolCall, type IdeBridge } from './ide-tools'

function bridge(): IdeBridge {
  return {
    openDiff: vi.fn().mockResolvedValue('keep'),
    openFile: vi.fn(), getWorkspaceFolders: vi.fn().mockResolvedValue(['/w']),
    getCurrentSelection: vi.fn(), getOpenEditors: vi.fn(),
    checkDocumentDirty: vi.fn(), saveDocument: vi.fn(),
  }
}

describe('ide-server', () => {
  let server: IdeServer
  afterEach(async () => { await server?.close() })

  function connect(port: number, token: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { 'x-claude-code-ide-authorization': token },
    })
  }

  function rpc(ws: WebSocket, id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { id: number; result?: unknown }
        if (msg.id === id) {resolve(msg)}
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  it('responds to MCP initialize', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'tok')
    await new Promise((r) => ws.on('open', r))
    const res = await rpc(ws, 1, 'initialize', {}) as { result: { protocolVersion: string } }
    expect(res.result.protocolVersion).toBe('2024-11-05')
    ws.close()
  })

  it('rejects a connection with a bad auth token', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'WRONG')
    const closed = await new Promise<boolean>((r) => { ws.on('close', () => r(true)); ws.on('error', () => r(true)) })
    expect(closed).toBe(true)
  })

  it('routes tools/call to handleToolCall', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'tok')
    await new Promise((r) => ws.on('open', r))
    const res = await rpc(ws, 2, 'tools/call', { name: 'getWorkspaceFolders', arguments: {} }) as { result: { content: { text: string }[] } }
    expect(res.result.content[0].text).toBe(JSON.stringify(['/w']))
    ws.close()
  })

  it('tools/list returns a non-empty array containing openDiff with inputSchema', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'tok')
    await new Promise((r) => ws.on('open', r))
    const res = await rpc(ws, 3, 'tools/list', {}) as { result: { tools: { name: string; inputSchema: unknown }[] } }
    expect(res.result.tools.length).toBeGreaterThan(0)
    const openDiff = res.result.tools.find((t) => t.name === 'openDiff')
    expect(openDiff).toBeDefined()
    expect(openDiff?.inputSchema).toBeDefined()
    ws.close()
  })

  it('does not respond to JSON-RPC notifications (no id)', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'tok')
    await new Promise((r) => ws.on('open', r))
    const received = new Promise<boolean>((resolve) => {
      ws.on('message', () => resolve(true))
      setTimeout(() => resolve(false), 100)
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    const gotMessage = await received
    expect(gotMessage).toBe(false)
    ws.close()
  })

  it('notify sends a JSON-RPC notification to connected clients', async () => {
    server = await startIdeServer({ port: 0, authToken: 'tok', bridge: bridge(), handleToolCall })
    const ws = connect(server.port, 'tok')
    await new Promise((r) => ws.on('open', r))
    const received = new Promise<unknown>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (!msg.id) {resolve(msg)}
      })
    })
    server.notify('selection_changed', { text: 'hello', filePath: '/w/a.ts' })
    const notif = await received as { jsonrpc: string; method: string; params: unknown }
    expect(notif.jsonrpc).toBe('2.0')
    expect(notif.method).toBe('selection_changed')
    expect(notif.params).toEqual({ text: 'hello', filePath: '/w/a.ts' })
    ws.close()
  })
})
