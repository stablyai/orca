import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DaemonToolRelayFront,
  TOOL_RELAY_FRONT_MAX_HELD,
  TOOL_RELAY_FRONT_MAX_PIPES
} from './daemon-tool-relay-front'

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

/** An agent's connection to the front; resolves with everything it read once it closed. */
function agent(port: number): { socket: Socket; answer: Promise<string> } {
  const socket = connect(port, '127.0.0.1')
  opened.push(socket)
  let read = ''
  socket.on('data', (chunk) => (read += chunk.toString('utf8')))
  socket.on('error', () => {})
  return { socket, answer: new Promise((resolve) => socket.once('close', () => resolve(read))) }
}

/** The app's side of a splice: one end of a connected loopback pair. */
async function appSocket(): Promise<Socket> {
  if (!pairs) {
    pairs = createServer((accepted) => {
      opened.push(accepted)
      accepted.on('error', () => {})
    })
    await new Promise<void>((resolve) => pairs!.listen(0, '127.0.0.1', resolve))
  }
  const address = pairs.address()
  const socket = connect(typeof address === 'object' && address ? address.port : 0, '127.0.0.1')
  opened.push(socket)
  socket.on('error', () => {})
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  return socket
}

describe.skipIf(process.platform === 'win32')('tool relay front bounds', () => {
  it('holds at most 64 connections, answers the rest 503 at once, and frees each on splice and close', async () => {
    front = new DaemonToolRelayFront()
    const port = await front.open()
    const announced: string[] = []
    const held = Array.from({ length: TOOL_RELAY_FRONT_MAX_HELD }, () => agent(port))
    await vi.waitFor(() => expect(front!.heldCount).toBe(TOOL_RELAY_FRONT_MAX_HELD))
    const over = agent(port)
    expect(await over.answer).toContain('503 Service Unavailable')
    expect(front.heldCount).toBe(TOOL_RELAY_FRONT_MAX_HELD)

    // Registering announces every held connection; each splice frees its hold for a pipe.
    front.serve('app', (id) => announced.push(id))
    expect(announced).toHaveLength(TOOL_RELAY_FRONT_MAX_HELD)
    for (const id of announced) {
      front.splice(id, await appSocket(), 'app')
    }
    expect(front.heldCount).toBe(0)
    expect(front.pipeCount).toBe(TOOL_RELAY_FRONT_MAX_HELD)

    // An agent closing frees its pipe.
    held[0]!.socket.destroy()
    await vi.waitFor(() => expect(front!.pipeCount).toBe(TOOL_RELAY_FRONT_MAX_HELD - 1))
    // The app going frees every pipe it answered.
    front.clientGone('app')
    expect(front.pipeCount).toBe(0)
  })

  it('answers a connection no app takes within the hold, and frees it', async () => {
    front = new DaemonToolRelayFront(50)
    const port = await front.open()
    const { answer } = agent(port)
    const text = await answer
    expect(text).toContain('503 Service Unavailable')
    expect(text).toContain('Retry-After: 5')
    expect(text).toContain('Orca is restarting')
    expect(front.heldCount).toBe(0)
  })

  it('keeps live pipes at 256 however many connections arrive', async () => {
    front = new DaemonToolRelayFront()
    const port = await front.open()
    let spliced = 0
    const answered: Promise<string>[] = []
    front.serve('app', (id) => {
      void appSocket().then((socket) => {
        if (front!.splice(id, socket, 'app')) {
          spliced += 1
        }
      })
    })
    for (let index = 0; index < TOOL_RELAY_FRONT_MAX_PIPES + 8; index += 1) {
      const { answer } = agent(port)
      answered.push(answer)
      // Below the hold cap, so every refusal is the pipe cap's.
      await vi.waitFor(() => expect(front!.heldCount).toBe(0))
    }
    expect(front.pipeCount).toBe(TOOL_RELAY_FRONT_MAX_PIPES)
    expect(spliced).toBe(TOOL_RELAY_FRONT_MAX_PIPES)
    const refused = (await Promise.all(answered.slice(TOOL_RELAY_FRONT_MAX_PIPES))).filter((text) =>
      text.includes('503')
    )
    expect(refused).toHaveLength(8)
    front.clientGone('app')
    expect(front.pipeCount).toBe(0)
  }, 30_000)
})
