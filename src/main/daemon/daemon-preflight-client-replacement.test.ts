import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { encodeNdjson } from './ndjson'
import { PROTOCOL_VERSION } from './types'
import type { SubprocessHandle } from './session'

type DaemonServerPrivate = {
  pendingPtySpawnPreparations: Map<string, Set<unknown>>
  clients: Map<string, { streamSocket: Socket | null }>
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    confirmForegroundProcess: vi.fn(async () => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 0)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (code: number) => void) => {
      onExitCb = cb
    }),
    dispose: vi.fn()
  }
}

describe('daemon preflight client replacement', () => {
  let dir: string
  let server: DaemonServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-preflight-replacement-'))
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function connectDaemonSocketPair(
    socketPath: string,
    tokenPath: string,
    clientId: string
  ): Promise<{ control: Socket; stream: Socket }> {
    const token = readFileSync(tokenPath, 'utf-8').trim()
    const connectRole = async (role: 'control' | 'stream'): Promise<Socket> => {
      const socket = connect(socketPath)
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write(
        encodeNdjson({ type: 'hello', version: PROTOCOL_VERSION, token, clientId, role })
      )
      await new Promise<void>((resolve) => socket.once('data', () => resolve()))
      return socket
    }
    return { control: await connectRole('control'), stream: await connectRole('stream') }
  }

  it('cancels preparation when a reconnect replaces the owning control socket', async () => {
    let finishPreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const preparePtySpawn = vi.fn(() => preparation)
    const spawnSubprocess = vi.fn(() => createMockSubprocess())
    const socketPath = join(dir, 'daemon.sock')
    const tokenPath = join(dir, 'daemon.token')
    server = new DaemonServer({ socketPath, tokenPath, preparePtySpawn, spawnSubprocess })
    await server.start()

    const original = new DaemonClient({ socketPath, tokenPath })
    const replacement = new DaemonClient({ socketPath, tokenPath })
    ;(original as unknown as { clientId: string }).clientId = 'reused-client-id'
    ;(replacement as unknown as { clientId: string }).clientId = 'reused-client-id'
    await original.ensureConnected()
    original
      .request('createOrAttach', {
        sessionId: 'replacement-pending',
        cols: 80,
        rows: 24
      })
      .catch(() => {
        /* replacement disconnects the original request */
      })
    await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledOnce())

    await replacement.ensureConnected()
    finishPreparation()
    await vi.waitFor(() =>
      expect((server as unknown as DaemonServerPrivate).pendingPtySpawnPreparations.size).toBe(0)
    )
    expect(spawnSubprocess).not.toHaveBeenCalled()

    replacement.disconnect()
    original.disconnect()
  })

  it('cancels only the preparation whose client loses its stream socket', async () => {
    let finishPreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const preparePtySpawn = vi.fn(() => preparation)
    const spawnSubprocess = vi.fn(() => createMockSubprocess())
    const socketPath = join(dir, 'daemon.sock')
    const tokenPath = join(dir, 'daemon.token')
    server = new DaemonServer({ socketPath, tokenPath, preparePtySpawn, spawnSubprocess })
    await server.start()

    const disconnectedClientId = 'stream-loss-client'
    const survivingClientId = 'stream-survivor-client'
    const disconnected = await connectDaemonSocketPair(socketPath, tokenPath, disconnectedClientId)
    const survivor = await connectDaemonSocketPair(socketPath, tokenPath, survivingClientId)
    disconnected.control.write(
      encodeNdjson({
        id: 'req-stream-loss',
        type: 'createOrAttach',
        payload: { sessionId: 'stream-loss-pending', cols: 80, rows: 24 }
      })
    )
    survivor.control.write(
      encodeNdjson({
        id: 'req-stream-survivor',
        type: 'createOrAttach',
        payload: { sessionId: 'stream-survivor-pending', cols: 80, rows: 24 }
      })
    )
    await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledTimes(2))

    disconnected.stream.destroy()
    await vi.waitFor(() =>
      expect(
        (server as unknown as DaemonServerPrivate).clients.get(disconnectedClientId)?.streamSocket
      ).toBeNull()
    )
    finishPreparation()
    await vi.waitFor(() =>
      expect((server as unknown as DaemonServerPrivate).pendingPtySpawnPreparations.size).toBe(0)
    )
    expect(spawnSubprocess).toHaveBeenCalledOnce()

    disconnected.control.destroy()
    survivor.control.destroy()
    survivor.stream.destroy()
  })
})
