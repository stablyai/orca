import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fingerprintSharedMcpDefinition,
  SharedMcpToolsBridge,
  type SharedMcpToolsBridgeConnection
} from './index'

const fixturePath = fileURLToPath(new URL('./test-fixtures/tools-server.mjs', import.meta.url))

type ConnectedClient = {
  client: Client
  transport: StreamableHTTPClientTransport
}

function readResult(result: Awaited<ReturnType<Client['callTool']>>): {
  pid: number
  value: string | null
} {
  const content = 'content' in result && Array.isArray(result.content) ? result.content : []
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Unexpected fixture result')
  }
  return JSON.parse(first.text)
}

async function connectClient(
  connection: SharedMcpToolsBridgeConnection,
  name: string
): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(connection.url, {
    requestInit: { headers: connection.headers }
  })
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('Condition was not met before timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('SharedMcpToolsBridge', () => {
  const bridges: SharedMcpToolsBridge[] = []
  const clients: ConnectedClient[] = []

  afterEach(async () => {
    await Promise.allSettled(
      clients.splice(0).map(async ({ client, transport }) => {
        await transport.terminateSession().catch(() => undefined)
        await client.close().catch(() => undefined)
      })
    )
    await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()))
  })

  it('serves five isolated sessions through one downstream stdio process', async () => {
    const bridge = new SharedMcpToolsBridge(
      { command: process.execPath, args: [fixturePath] },
      { idleTimeoutMs: 25, token: 'test-token' }
    )
    bridges.push(bridge)
    const connection = await bridge.start()
    clients.push(
      ...(await Promise.all(
        Array.from({ length: 5 }, (_, index) => connectClient(connection, `client-${index}`))
      ))
    )

    const results = await Promise.all(
      clients.map(({ client }, index) =>
        client.callTool({ name: 'echo', arguments: { value: `value-${index}` } })
      )
    )
    const parsed = results.map(readResult)

    expect(new Set(parsed.map(({ pid }) => pid))).toHaveLength(1)
    expect(parsed.map(({ value }) => value)).toEqual(
      Array.from({ length: 5 }, (_, index) => `value-${index}`)
    )
    expect(bridge.getStatus()).toMatchObject({
      downstreamPid: parsed[0].pid,
      sessionCount: 5
    })

    const disconnected = clients.shift()!
    await disconnected.transport.terminateSession()
    await disconnected.client.close()
    expect(readResult(await clients[0].client.callTool({ name: 'echo' })).pid).toBe(parsed[0].pid)

    await Promise.all(
      clients.map(async ({ client, transport }) => {
        await transport.terminateSession()
        await client.close()
      })
    )
    clients.length = 0
    await eventually(() => bridge.getStatus().downstreamPid === null)
    expect(bridge.getStatus().sessionCount).toBe(0)
  })

  it('requires its bearer token and restarts a crashed downstream', async () => {
    const bridge = new SharedMcpToolsBridge(
      { command: process.execPath, args: [fixturePath] },
      { token: 'correct-token' }
    )
    bridges.push(bridge)
    const connection = await bridge.start()

    await expect(
      connectClient({ ...connection, headers: { authorization: 'Bearer wrong-token' } }, 'wrong')
    ).rejects.toThrow()

    const connected = await connectClient(connection, 'survivor')
    clients.push(connected)
    const first = readResult(await connected.client.callTool({ name: 'exit' }))
    await eventually(() => bridge.getStatus().downstreamPid === null)
    const second = readResult(await connected.client.callTool({ name: 'echo' }))

    expect(second.pid).not.toBe(first.pid)
  })

  it('includes cwd and secret environment values in a non-reversible pool identity', () => {
    const base = { command: 'server', args: ['--stdio'], cwd: 'C:/one', env: { TOKEN: 'one' } }
    expect(fingerprintSharedMcpDefinition(base)).toBe(fingerprintSharedMcpDefinition(base))
    expect(fingerprintSharedMcpDefinition({ ...base, cwd: 'C:/two' })).not.toBe(
      fingerprintSharedMcpDefinition(base)
    )
    expect(fingerprintSharedMcpDefinition({ ...base, env: { TOKEN: 'two' } })).not.toBe(
      fingerprintSharedMcpDefinition(base)
    )
    expect(fingerprintSharedMcpDefinition({ ...base, isolationKey: 'workspace-two' })).not.toBe(
      fingerprintSharedMcpDefinition(base)
    )
    expect(fingerprintSharedMcpDefinition(base)).not.toContain('one')
  })
})
