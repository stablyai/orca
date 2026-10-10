import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectDiscordIpc } from './discord-ipc-client'
import {
  DISCORD_IPC_OPCODE,
  DiscordIpcPacketDecoder,
  encodeDiscordIpcPacket,
  type DiscordIpcPacket
} from './discord-ipc-packet'

const CLIENT_ID = '123456789012345678'
const quietLogger = { debug: vi.fn(), warn: vi.fn() }

type FakeDiscord = {
  path: string
  received: DiscordIpcPacket[]
  sockets: Socket[]
  close: () => Promise<void>
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function socketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-discord-test-${randomUUID()}`
  }
  const dir = mkdtempSync(join(tmpdir(), 'orca-discord-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'discord-ipc-0')
}

async function startFakeDiscord(
  onPacket: (packet: DiscordIpcPacket, socket: Socket) => void
): Promise<FakeDiscord> {
  const path = socketPath()
  const received: DiscordIpcPacket[] = []
  const sockets: Socket[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    const decoder = new DiscordIpcPacketDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const packet of decoder.push(chunk)) {
        received.push(packet)
        onPacket(packet, socket)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const close = () =>
    new Promise<void>((resolve) => {
      sockets.forEach((socket) => socket.destroy())
      server.close(() => resolve())
    })
  cleanups.push(close)
  return { path, received, sockets, close }
}

function acceptHandshake(packet: DiscordIpcPacket, socket: Socket): void {
  if (packet.op === DISCORD_IPC_OPCODE.handshake) {
    socket.write(
      encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.frame, { cmd: 'DISPATCH', evt: 'READY' })
    )
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2_000 })
}

describe('connectDiscordIpc', () => {
  it('handshakes with the client id and sends SET_ACTIVITY with the pid', async () => {
    const discord = await startFakeDiscord(acceptHandshake)
    const connection = await connectDiscordIpc(
      { clientId: CLIENT_ID, socketPaths: [discord.path], pid: 4242, onClosed: vi.fn() },
      quietLogger
    )
    cleanups.push(() => connection.close())

    expect(discord.received[0]).toEqual({
      op: DISCORD_IPC_OPCODE.handshake,
      payload: { v: 1, client_id: CLIENT_ID }
    })
    connection.setActivity({ type: 0, details: 'Idle' })
    await waitFor(() => discord.received.length === 2)
    expect(discord.received[1]).toMatchObject({
      op: DISCORD_IPC_OPCODE.frame,
      payload: { cmd: 'SET_ACTIVITY', args: { pid: 4242, activity: { details: 'Idle' } } }
    })

    connection.setActivity(null)
    await waitFor(() => discord.received.length === 3)
    expect(discord.received[2].payload).toMatchObject({ args: { pid: 4242 } })
    expect(discord.received[2].payload).not.toHaveProperty('args.activity')
  })

  it('answers PING with PONG carrying the same payload', async () => {
    const discord = await startFakeDiscord(acceptHandshake)
    const connection = await connectDiscordIpc(
      { clientId: CLIENT_ID, socketPaths: [discord.path], pid: 1, onClosed: vi.fn() },
      quietLogger
    )
    cleanups.push(() => connection.close())

    discord.sockets[0].write(encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.ping, { n: 7 }))
    await waitFor(() => discord.received.some((p) => p.op === DISCORD_IPC_OPCODE.pong))
    expect(discord.received.find((p) => p.op === DISCORD_IPC_OPCODE.pong)?.payload).toEqual({
      n: 7
    })
  })

  it('reports an established connection closing from Discord', async () => {
    const discord = await startFakeDiscord(acceptHandshake)
    const onClosed = vi.fn()
    await connectDiscordIpc(
      { clientId: CLIENT_ID, socketPaths: [discord.path], pid: 1, onClosed },
      quietLogger
    )
    await discord.close()
    await waitFor(() => onClosed.mock.calls.length === 1)
  })

  it('moves to the next socket when one rejects the handshake', async () => {
    const rejecting = await startFakeDiscord((packet, socket) => {
      if (packet.op === DISCORD_IPC_OPCODE.handshake) {
        socket.write(encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.close, { code: 4000 }))
      }
    })
    const accepting = await startFakeDiscord(acceptHandshake)
    const connection = await connectDiscordIpc(
      {
        clientId: CLIENT_ID,
        socketPaths: [socketPath(), rejecting.path, accepting.path],
        pid: 1,
        onClosed: vi.fn()
      },
      quietLogger
    )
    cleanups.push(() => connection.close())
    expect(accepting.received).toHaveLength(1)
  })

  it('rejects when no socket accepts', async () => {
    await expect(
      connectDiscordIpc(
        { clientId: CLIENT_ID, socketPaths: [socketPath()], pid: 1, onClosed: vi.fn() },
        quietLogger
      )
    ).rejects.toThrow()
  })

  it('does not probe sockets for an unconfigured client id', async () => {
    const discord = await startFakeDiscord(acceptHandshake)
    await expect(
      connectDiscordIpc(
        { clientId: '<unset>', socketPaths: [discord.path], pid: 1, onClosed: vi.fn() },
        quietLogger
      )
    ).rejects.toThrow(/not configured/)
    expect(discord.sockets).toHaveLength(0)
  })
})
