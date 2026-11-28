// Guards #51086's per-call daemon work: an app that stopped reading its stream gets a bounded
// backlog of front notices, and a tool call's own daemon connection runs no idle check (which
// reads every terminal session) when it closes.
import '../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '../transport/client/daemon-client'
import { openDaemonToolRelayConnection } from '../transport/client/daemon-client-tool-relay-connection'
import { DaemonServer } from '../server/daemon-server'
import { DaemonServerLifecycle } from '../server/daemon-server-lifecycle'
import { getDaemonSocketPath } from '../launch/daemon-spawner'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import type { ToolRelayFrontOpenResult } from '../protocol/daemon-tool-relay-front-protocol'
import { DaemonToolRelayFront } from './daemon-tool-relay-front'
import { answerToolRelayFrontRequest } from './daemon-tool-relay-front-requests'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

/** A connected socket whose far end doesn't read until `peer` resumes, so writes stay queued. */
async function unreadStream(): Promise<Socket & { peer: Promise<Socket> }> {
  let accepted: (peer: Socket) => void = () => {}
  const peer = new Promise<Socket>((resolve) => (accepted = resolve))
  const server: Server = createServer((socket) => {
    socket.pause()
    accepted(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  const socket = connect(port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  cleanups.push(async () => {
    ;(await peer).destroy()
    socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return Object.assign(socket, { peer })
}

describe.skipIf(process.platform === 'win32')('front notices on a stalled app stream', () => {
  it('stop queueing past the unread bound, however many relay ends follow', async () => {
    const front = new DaemonToolRelayFront('start-1')
    cleanups.push(() => front.dispose())
    const control = await unreadStream()
    const stream = await unreadStream()
    const client = {
      clientId: 'app',
      controlSocket: control,
      streamSocket: stream,
      authenticatedPairEstablished: true
    }
    await answerToolRelayFrontRequest(
      { id: '1', type: 'toolRelayFrontServe' },
      client,
      control,
      front
    )
    // Each relay end is announced on the stream; far more than the socket and the bound can hold.
    const grant = { owner: 'scout', token: 'tok', folders: { bot: '/bots/scout' } }
    for (let relay = 0; relay < 300_000; relay += 1) {
      front.kept.keep(`r-${relay}`, `chat-${relay}`, { grants: [grant] })
      front.forgetKept(`r-${relay}`)
    }
    // At most one notice past the bound (the write that crossed it) is queued.
    expect(stream.writableLength).toBeLessThanOrEqual(1024 * 1024 + 1024)
    // Once the app reads again, the ends held back come as one notice to serve again.
    const reader = await stream.peer
    const changed = new Promise<void>((resolve) => {
      let tail = ''
      reader.on('data', (chunk) => {
        tail = (tail + chunk.toString('utf8')).slice(-4096)
        if (tail.includes('"keptChanged":true')) {
          resolve()
        }
      })
    })
    reader.resume()
    await changed
  })

  it("a tool call's daemon connection closing runs no idle check", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-relay-idle-'))
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
    const announced = new Promise<string>((resolve) =>
      client.onEvent((event) => {
        const id = jsonProperty(jsonProperty(event, 'payload'), 'frontConnectionId')
        if (typeof id === 'string') {
          resolve(id)
        }
      })
    )
    const { port } = await client.request<ToolRelayFrontOpenResult>('toolRelayFrontOpen', undefined)
    await client.request('toolRelayFrontServe', undefined)
    const agent = connect(port, '127.0.0.1')
    agent.on('error', () => {})
    agent.write('POST /bot-tools/x/mcp HTTP/1.1\r\n\r\n')
    cleanups.push(() => {
      agent.destroy()
    })
    const id = await announced
    const idleChecks = vi.spyOn(DaemonServerLifecycle.prototype, 'reevaluateIdleShutdown')
    cleanups.push(() => idleChecks.mockRestore())
    const { socket: app, remainder } = await openDaemonToolRelayConnection(client, id)
    cleanups.push(() => {
      app.destroy()
    })
    // The held request reaches the app's connection, and its answer reaches the agent.
    await new Promise<void>((resolve) => {
      // Bytes spliced in right behind the hello come back with it.
      let seen = remainder.toString('utf8')
      const check = (): void => {
        if (seen.includes('\r\n\r\n')) {
          resolve()
        }
      }
      check()
      app.on('data', (chunk) => {
        seen += chunk.toString('utf8')
        check()
      })
      app.resume()
    })
    const answered = new Promise<void>((resolve) => {
      let read = ''
      agent.on('data', (chunk) => {
        read += chunk.toString('utf8')
        if (read.includes('200 OK')) {
          resolve()
        }
      })
    })
    app.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
    await answered
    agent.destroy()
    app.destroy()
    // The daemon's end closes a moment after this one, with nothing outside it to wait on.
    // ast-grep-ignore: test-no-real-time-wait -- the daemon-side close has no observable signal here
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(idleChecks).not.toHaveBeenCalled()
  })
})
