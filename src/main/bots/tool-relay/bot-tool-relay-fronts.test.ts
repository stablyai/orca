import '../../daemon/pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../daemon/transport/client/daemon-client'
import { DaemonServer } from '../../daemon/server/daemon-server'
import { getDaemonSocketPath } from '../../daemon/launch/daemon-spawner'
import { installProviderRelayRoute } from '../../provider-relay/provider-relay-route'
import { BotToolRelay } from './bot-tool-relay'
import { TOOL_RELAY_FRONT_MAX_PIPES } from '../../daemon/tool-relay-front/daemon-tool-relay-front'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function daemon(): Promise<DaemonClient> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-relay-fronts-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess: () => {
      throw new Error('no terminals here')
    }
  })
  await server.start()
  const client = new DaemonClient({ socketPath, tokenPath })
  await client.ensureConnected()
  cleanups.push(async () => {
    client.disconnect()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  return client
}

/** A kept agent's call to the front; resolves with everything it read once it closed. */
function agentCall(port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  socket.write(request)
  let read = ''
  socket.on('data', (chunk) => (read += chunk.toString('utf8')))
  cleanups.push(() => {
    socket.destroy()
  })
  return new Promise((resolve) => socket.once('close', () => resolve(read)))
}

async function servedFront(): Promise<number> {
  const client = await daemon()
  installProviderRelayRoute({
    current: async () => client,
    all: async () => [client],
    appVersion: 'test',
    idleStopMs: () => null
  })
  const relay = new BotToolRelay(async () => new Response('{}'))
  cleanups.push(() => {
    relay.close()
    installProviderRelayRoute(null)
  })
  const front = await relay.kept.fronts.current('chat-1')
  expect(front?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  return Number(new URL(front!.origin).port)
}

describe.skipIf(process.platform === 'win32')('tool relay fronts', () => {
  it("a kept agent's request through the front reaches the relay's own checks", async () => {
    const port = await servedFront()
    // Sent before any app connection exists: held, then read only through the app's own one.
    const reply = agentCall(
      port,
      `POST /bot-tools/abcdefgh/mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`
    )
    const answer = await reply
    // The relay parsed it: no bearer is refused by its own check, as on its own port.
    expect(answer).toMatch(/^HTTP\/1\.1 401 /)
  })

  // 260 sequential connections through a real daemon, each a socket, hello and splice.
  it('keep-alive calls past the pipe cap never hold pipes, so cleanup still gets through', async () => {
    const port = await servedFront()
    // Each asks to keep its connection; the relay closes it after answering, freeing its pipe.
    for (let call = 0; call < TOOL_RELAY_FRONT_MAX_PIPES + 4; call += 1) {
      const answer = await agentCall(
        port,
        `POST /bot-tools/abcdefgh/mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}`
      )
      expect(answer).toMatch(/^HTTP\/1\.1 401 /)
    }
    const cleanup = await agentCall(
      port,
      `DELETE /bot-tools/abcdefgh/mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`
    )
    expect(cleanup).toMatch(/^HTTP\/1\.1 401 /)
  }, 60_000)
})
