import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  ASK_TOOL_NAME,
  createMatrixMcpServer,
  SEND_TOOL_NAME,
  SESSION_INFO_TOOL_NAME
} from './stdio-server'

type CapturedRequest = {
  method: string | undefined
  url: string | undefined
  token: string | undefined
  body: unknown
}

// A fake loopback hook server so the tools' real HTTP path is exercised with
// the right header/body, without standing up the Electron main process.
function startFakeHookServer(
  respond: (req: CapturedRequest) => { status: number; json: unknown }
): Promise<{ port: number; close: () => void; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      const request: CapturedRequest = {
        method: req.method,
        url: req.url,
        token: req.headers['x-orca-agent-hook-token'] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined
      }
      captured.push(request)
      const { status, json } = respond(request)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      resolve({ port, close: () => server.close(), captured })
    })
  })
}

async function connectClient(env: NodeJS.ProcessEnv): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = createMatrixMcpServer(env)
  await mcp.connect(serverTransport)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

describe('matrix-mcp stdio server', () => {
  let hook: Awaited<ReturnType<typeof startFakeHookServer>> | null = null

  afterEach(() => {
    hook?.close()
    hook = null
  })

  it('initialize + tools/list exposes the relay tools with session-scoped descriptions', async () => {
    const client = await connectClient({})
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    expect(names).toEqual([SEND_TOOL_NAME, SESSION_INFO_TOOL_NAME, ASK_TOOL_NAME].sort())
    for (const tool of tools.tools) {
      expect(tool.description).toContain('running inside an Orca session')
    }
    await client.close()
  })

  it('orca_ask_operator POSTs the question and returns the operator answer', async () => {
    hook = await startFakeHookServer(() => ({
      status: 200,
      json: { ok: true, answered: true, answer: 'yes, proceed', handle: 'abcd' }
    }))
    const client = await connectClient({
      ORCA_PANE_KEY: 'pane-42',
      ORCA_AGENT_HOOK_PORT: String(hook.port),
      ORCA_AGENT_HOOK_TOKEN: 'tok-123'
    })

    const result = await client.callTool({
      name: ASK_TOOL_NAME,
      arguments: { question: 'should I proceed?', timeoutSeconds: 30 }
    })

    const request = hook.captured[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/matrix/ask')
    expect(request.token).toBe('tok-123')
    expect(request.body).toEqual({
      paneKey: 'pane-42',
      question: 'should I proceed?',
      timeoutMs: 30_000
    })

    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toBe('yes, proceed')
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  it('orca_ask_operator returns an isError no-answer message on timeout', async () => {
    hook = await startFakeHookServer(() => ({
      status: 200,
      json: { ok: true, answered: false, reason: 'timeout', handle: 'abcd' }
    }))
    const client = await connectClient({
      ORCA_PANE_KEY: 'pane-42',
      ORCA_AGENT_HOOK_PORT: String(hook.port),
      ORCA_AGENT_HOOK_TOKEN: 'tok-123'
    })

    const result = await client.callTool({
      name: ASK_TOOL_NAME,
      arguments: { question: 'should I proceed?', timeoutSeconds: 5 }
    })

    expect(result.isError).toBe(true)
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain('No answer')
    await client.close()
  })

  it('orca_send_message POSTs to the hook server with the right header/body and returns the handle', async () => {
    hook = await startFakeHookServer(() => ({ status: 200, json: { ok: true, handle: 'abcd' } }))
    const client = await connectClient({
      ORCA_PANE_KEY: 'pane-42',
      ORCA_AGENT_HOOK_PORT: String(hook.port),
      ORCA_AGENT_HOOK_TOKEN: 'tok-123'
    })

    const result = await client.callTool({
      name: SEND_TOOL_NAME,
      arguments: { message: 'hello operator' }
    })

    const request = hook.captured[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/matrix/send')
    expect(request.token).toBe('tok-123')
    expect(request.body).toEqual({ paneKey: 'pane-42', message: 'hello operator' })

    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain('abcd')
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  it('orca_send_message returns a loud error when not in an Orca session', async () => {
    const client = await connectClient({})
    const result = await client.callTool({
      name: SEND_TOOL_NAME,
      arguments: { message: 'hello' }
    })
    expect(result.isError).toBe(true)
    const text = (result.content as { type: string; text: string }[])[0].text
    expect(text).toContain('Not in an Orca session')
    await client.close()
  })

  it('orca_session_info GETs the hook server and reports handle, room, and enabled', async () => {
    hook = await startFakeHookServer(() => ({
      status: 200,
      json: { handle: 'abcd', roomId: '!room:server', enabled: true }
    }))
    const client = await connectClient({
      ORCA_PANE_KEY: 'pane-42',
      ORCA_AGENT_HOOK_PORT: String(hook.port),
      ORCA_AGENT_HOOK_TOKEN: 'tok-123'
    })

    const result = await client.callTool({ name: SESSION_INFO_TOOL_NAME, arguments: {} })
    const request = hook.captured[0]
    expect(request.method).toBe('GET')
    expect(request.url).toBe('/matrix/session-info?paneKey=pane-42')

    const text = (result.content as { type: string; text: string }[])[0].text
    const parsed = JSON.parse(text)
    expect(parsed.handle).toBe('abcd')
    expect(parsed.roomId).toBe('!room:server')
    expect(parsed.enabled).toBe(true)
    await client.close()
  })
})
