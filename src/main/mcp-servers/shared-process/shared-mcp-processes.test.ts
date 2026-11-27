import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpCommandServer } from '../mcp-shared-process-servers'
import { SharedMcpProcesses } from './shared-mcp-processes'

// A stdio MCP server whose one tool names the process that answered and its MARK env; it logs the
// resource subscriptions it's asked for.
const SERVER = `
require('node:fs').appendFileSync(process.argv[2], process.pid + '\\n')
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('data', (c) => {
  buf += c
  for (let i; (i = buf.indexOf('\\n')) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === undefined) continue
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: 'pid', version: '1' } } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } })
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: process.pid + ':' + process.env.MARK }] } })
    else if (m.method.startsWith('resources/')) { require('node:fs').appendFileSync(process.argv[2] + '.subs', m.method + ' ' + m.params.uri + '\\n'); send({ jsonrpc: '2.0', id: m.id, result: {} }) }
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } })
  }
})
process.stdin.on('end', () => process.exit(0))
`

const ID = 'server-0001'
// Children start slowly when the machine is busy.
const POLL = { timeout: 15_000 }

describe('SharedMcpProcesses', () => {
  let dir: string
  let http: Server
  let url: string
  let stored: McpCommandServer | null
  let spawned: number
  let started: Promise<void>
  let processes: SharedMcpProcesses

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shared-mcp-'))
    writeFileSync(join(dir, 'server.cjs'), SERVER)
    const args = [join(dir, 'server.cjs'), join(dir, 'pids')]
    stored = { name: 'pid', command: 'node', args, env: { MARK: 'one' } }
    vi.stubEnv('ORCA_MCP_SERVERS', '1')
    spawned = 0
    started = Promise.resolve()
    processes = new SharedMcpProcesses({
      servers: async () => new Map(stored ? [[ID, stored]] : []),
      prepare: async (server) => {
        spawned += 1
        await started
        return {
          program: process.execPath,
          args: server.args,
          env: { PATH: process.env.PATH ?? '', ...server.env },
          cwd: dir
        }
      }
    })
    http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = req.method === 'POST' ? Buffer.concat(chunks) : undefined
        processes.handle({ folder: dir, serverId: ID, req, res, body }).catch((error) => {
          res.writeHead(typeof error?.status === 'number' ? error.status : 500)
          res.end()
        })
      })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    processes.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(new URL(url))
    const client = new Client({ name: 'agent', version: '1' })
    await client.connect(transport)
    return { client, transport }
  }

  async function whoami(client: Client): Promise<{ pid: number; mark: string }> {
    const result = await client.request(
      { method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      CallToolResultSchema
    )
    const [first] = result.content
    const [pid, mark] = first?.type === 'text' ? first.text.split(':') : []
    return { pid: Number(pid), mark: mark ?? '' }
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const readPids = (): number[] => {
    try {
      return readFileSync(join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number)
    } catch {
      return []
    }
  }

  const readSubs = (): string[] => {
    try {
      return readFileSync(join(dir, 'pids.subs'), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  const stopped = (pid: number) => expect.poll(() => alive(pid), POLL).toBe(false)

  it('runs one child for every session and stops it once the last session ends', async () => {
    const a = await connect()
    const b = await connect()
    const fromA = await whoami(a.client)
    const fromB = await whoami(b.client)
    expect(fromB.pid).toBe(fromA.pid)
    expect(spawned).toBe(1)

    await a.transport.terminateSession()
    await a.client.close()
    expect((await whoami(b.client)).pid).toBe(fromA.pid)
    expect(alive(fromA.pid)).toBe(true)

    await b.transport.terminateSession()
    await b.client.close()
    await stopped(fromA.pid)
  })

  it('starts a new child when the command changes and stops it when no longer shared', async () => {
    const a = await connect()
    const first = await whoami(a.client)
    stored = { ...stored!, env: { MARK: 'two' } }
    // The old child's session is gone; a reconnecting agent reaches the new command.
    await expect(whoami(a.client)).rejects.toThrow()
    await stopped(first.pid)
    const b = await connect()
    const second = await whoami(b.client)
    expect(second).toMatchObject({ mark: 'two' })
    expect(second.pid).not.toBe(first.pid)

    stored = null
    await expect(whoami(b.client)).rejects.toThrow()
    await stopped(second.pid)
  })

  it('stops the child when the only agent gave up while it was starting', async () => {
    let release = (): void => {}
    started = new Promise((resolve) => (release = resolve))
    const gaveUp = new AbortController()
    const initialize = fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'a', version: '1' }
        }
      }),
      signal: gaveUp.signal
    })
    await expect.poll(() => spawned, POLL).toBe(1)
    gaveUp.abort()
    await expect(initialize).rejects.toThrow()
    release()
    await expect.poll(() => readPids().length, POLL).toBe(1)
    await stopped(readPids()[0]!)
  })

  it('holds one child subscription per resource until its last agent lets go', async () => {
    const a = await connect()
    const b = await connect()
    const subscribe = (client: Client, method: 'resources/subscribe' | 'resources/unsubscribe') =>
      client.request({ method, params: { uri: 'file:///x' } }, EmptyResultSchema)
    await subscribe(a.client, 'resources/subscribe')
    await subscribe(b.client, 'resources/subscribe')
    await subscribe(a.client, 'resources/unsubscribe')
    expect(readSubs()).toEqual(['resources/subscribe file:///x'])

    await b.transport.terminateSession()
    await expect
      .poll(readSubs, POLL)
      .toEqual(['resources/subscribe file:///x', 'resources/unsubscribe file:///x'])
  })

  it('starts nothing while the MCP servers switch is off', async () => {
    vi.stubEnv('ORCA_MCP_SERVERS', '')
    await expect(connect()).rejects.toThrow()
    expect(spawned).toBe(0)
  })
})
