import '../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../transport/client/daemon-client'
import { openDaemonToolRelayConnection } from '../transport/client/daemon-client-tool-relay-connection'
import { DaemonServer } from '../server/daemon-server'
import { getDaemonSocketPath } from '../launch/daemon-spawner'
import { PROTOCOL_VERSION } from '../protocol/daemon-protocol-version'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import type { ToolRelayFrontOpenResult } from '../protocol/daemon-tool-relay-front-protocol'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function daemon(protocolVersion = PROTOCOL_VERSION) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-relay-front-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    protocolVersion,
    spawnSubprocess: () => {
      throw new Error('no terminals here')
    }
  })
  await server.start()
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  await client.ensureConnected()
  cleanups.push(async () => {
    client.disconnect()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  return { client, socketPath }
}

/** A kept agent's connection to the front: what it sent, and what came back before close. */
function agentCall(port: number, request: string): { socket: Socket; reply: Promise<string> } {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  socket.write(request)
  let read = ''
  socket.on('data', (chunk) => (read += chunk.toString('utf8')))
  cleanups.push(() => {
    socket.destroy()
  })
  return { socket, reply: new Promise((resolve) => socket.once('close', () => resolve(read))) }
}

function frontConnections(client: DaemonClient): () => Promise<string> {
  const ids: string[] = []
  const waiters: ((id: string) => void)[] = []
  client.onEvent((event) => {
    const id = jsonProperty(jsonProperty(event, 'payload'), 'frontConnectionId')
    if (jsonProperty(event, 'event') === 'toolRelayFrontConnection' && typeof id === 'string') {
      const waiter = waiters.shift()
      if (waiter) {
        waiter(id)
      } else {
        ids.push(id)
      }
    }
  })
  return () =>
    ids.length > 0 ? Promise.resolve(ids.shift()!) : new Promise((resolve) => waiters.push(resolve))
}

describe.skipIf(process.platform === 'win32')('tool relay front protocol', () => {
  it('splices an agent connection only into one the app opened and authenticated', async () => {
    const { client, socketPath } = await daemon()
    expect(client.getDaemonIdentity()?.toolRelayFront).toBe(true)
    const next = frontConnections(client)
    const { port } = await client.request<ToolRelayFrontOpenResult>('toolRelayFrontOpen', undefined)
    await client.request('toolRelayFrontServe', undefined)

    const { socket: agent, reply } = agentCall(port, 'POST /bot-tools/x/mcp HTTP/1.1\r\n\r\n')
    const id = await next()

    // A connection with the wrong token is refused before any request byte reaches it.
    const intruder = connect(socketPath)
    let stolen = ''
    intruder.on('data', (chunk) => (stolen += chunk.toString('utf8')))
    intruder.on('error', () => {})
    intruder.write(
      `${JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, token: 'wrong', clientId: 'x', role: 'tool-relay', frontConnectionId: id })}\n`
    )
    await new Promise((resolve) => intruder.once('close', resolve))
    expect(stolen).toContain('Invalid token')
    expect(stolen).not.toContain('POST /bot-tools')

    // The app's own connection gets the held request, and its answer reaches the agent.
    const { socket: app } = await openDaemonToolRelayConnection(client, id)
    cleanups.push(() => {
      app.destroy()
    })
    const request = await new Promise<string>((resolve) => {
      let seen = ''
      app.on('data', (chunk) => {
        seen += chunk.toString('utf8')
        if (seen.includes('\r\n\r\n')) {
          resolve(seen)
        }
      })
      app.resume()
    })
    expect(request).toContain('POST /bot-tools/x/mcp')
    app.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
    expect(await reply).toContain('200 OK')
    agent.destroy()
  })

  it('an older daemon offers no front, so its chats stay app-bound', async () => {
    const { client } = await daemon(PROTOCOL_VERSION - 1)
    expect(client.getDaemonIdentity()?.toolRelayFront).toBeUndefined()
    await expect(client.request('toolRelayFrontOpen', undefined)).rejects.toThrow()
  })
})
