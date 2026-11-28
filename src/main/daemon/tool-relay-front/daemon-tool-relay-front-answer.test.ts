// Guards #51086: a tool's answer the app finished sending reaches a slow agent whole.
import { connect, createServer, Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonToolRelayFront } from './daemon-tool-relay-front'

const opened: Socket[] = []
let front: DaemonToolRelayFront | null = null
let pairs: Server | null = null

afterEach(() => {
  front?.dispose()
  pairs?.close()
  for (const socket of opened.splice(0)) {
    socket.destroy()
  }
})

describe.skipIf(process.platform === 'win32')('tool relay front answers', () => {
  it('an answer still queued for a slow agent arrives whole after the app closes', async () => {
    front = new DaemonToolRelayFront('start-1')
    const port = await front.open()
    const ids: string[] = []
    front.serve('app', new Socket(), (event) => {
      if ('frontConnectionId' in event) {
        ids.push(event.frontConnectionId)
      }
    })
    const agent = connect(port, '127.0.0.1')
    opened.push(agent)
    agent.pause()
    await vi.waitFor(() => expect(ids).toHaveLength(1))

    // The app's process end, and the daemon's end of its connection that the front splices.
    const accepted = new Promise<Socket>((resolve) => {
      pairs = createServer((socket) => {
        opened.push(socket)
        resolve(socket)
      })
    })
    await new Promise<void>((resolve) => pairs!.listen(0, '127.0.0.1', resolve))
    const address = pairs!.address()
    const daemonEnd = connect(typeof address === 'object' && address ? address.port : 0, '127.0.0.1')
    opened.push(daemonEnd)
    await new Promise((resolve) => daemonEnd.once('connect', resolve))
    expect(front.splice(ids[0]!, daemonEnd, 'app')).toBe(true)

    // The agent reads a chunk per turn of the event loop, so the app finishes well before it does.
    const size = 8 * 1024 * 1024
    let received = 0
    agent.on('data', (chunk: Buffer) => {
      received += chunk.length
      agent.pause()
      setImmediate(() => agent.resume())
    })
    const closed = new Promise((resolve) => agent.once('close', resolve))
    ;(await accepted).end(Buffer.alloc(size, 7))
    agent.resume()
    await closed
    expect(received).toBe(size)
  }, 30_000)
})
