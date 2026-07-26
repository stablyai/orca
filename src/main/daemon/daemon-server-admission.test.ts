import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT,
  DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT,
  DAEMON_MAX_CONTROL_CLIENTS,
  DAEMON_MAX_STREAM_ATTACHMENTS,
  DAEMON_MAX_TRANSPORT_SOCKETS
} from './daemon-admission-limits'
import {
  DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT,
  DAEMON_RESPONSE_RESERVATION_BYTES
} from './daemon-response-admission'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { encodeNdjson } from './ndjson'
import { getDaemonSocketPath } from './daemon-spawner'
import { PROTOCOL_VERSION, type DaemonRequest } from './types'

type ConnectedClientState = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
  activeRequestCount: number
  activeRequestBytes: number
  activeResponseBytes: number
}

type DaemonServerAdmissionState = {
  transportSockets: Set<Socket>
  clients: Map<string, ConnectedClientState>
  activeRequestCount: number
  activeRequestBytes: number
  activeResponseBytes: number
  pendingPtySpawnPreparations: Map<string, Set<unknown>>
  dispatchRequest(socket: Socket, clientId: string, value: unknown, lineBytes: number): void
}

function readJsonLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = ''
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) {
        return
      }
      cleanup()
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('Socket closed before a response'))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

describe('DaemonServer admission', () => {
  let directory: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient | null
  let sockets: Socket[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-admission-test-'))
    socketPath = getDaemonSocketPath(directory)
    tokenPath = join(directory, 'daemon.token')
    client = null
    sockets = []
  })

  afterEach(async () => {
    client?.disconnect()
    for (const socket of sockets) {
      socket.destroy()
    }
    await server?.shutdown()
    rmSync(directory, { recursive: true, force: true })
  })

  async function startServer(
    preparePtySpawn?: () => Promise<void>,
    ptySpawnHealthCheck?: () => Promise<void>
  ): Promise<void> {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      ...(preparePtySpawn ? { preparePtySpawn } : {}),
      ...(ptySpawnHealthCheck ? { ptySpawnHealthCheck } : {}),
      spawnSubprocess: () => {
        throw new Error('Test unexpectedly spawned a subprocess')
      }
    })
    await server.start()
  }

  async function openSocket(): Promise<Socket> {
    const socket = connect(socketPath)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return socket
  }

  async function hello(
    role: 'control' | 'stream',
    clientId: string
  ): Promise<{ socket: Socket; response: Record<string, unknown> }> {
    const socket = await openSocket()
    const responsePromise = readJsonLine(socket)
    socket.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId,
        role
      })
    )
    return { socket, response: await responsePromise }
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    await vi.waitFor(() => expect(predicate()).toBe(true))
  }

  it('bounds pre-auth transports and releases capacity after disconnect', async () => {
    await startServer()
    const state = server as unknown as DaemonServerAdmissionState

    await Promise.all(Array.from({ length: DAEMON_MAX_TRANSPORT_SOCKETS }, () => openSocket()))
    await waitFor(() => state.transportSockets.size === DAEMON_MAX_TRANSPORT_SOCKETS)

    const overflow = await openSocket()
    await waitFor(() => overflow.destroyed)
    expect(state.transportSockets.size).toBe(DAEMON_MAX_TRANSPORT_SOCKETS)

    sockets[0].destroy()
    await waitFor(() => state.transportSockets.size === DAEMON_MAX_TRANSPORT_SOCKETS - 1)
    await openSocket()
    await waitFor(() => state.transportSockets.size === DAEMON_MAX_TRANSPORT_SOCKETS)
  })

  it('bounds control clients and stream attachments, then reuses released slots', async () => {
    await startServer()
    const state = server as unknown as DaemonServerAdmissionState
    const controls: Socket[] = []

    for (let index = 0; index < DAEMON_MAX_CONTROL_CLIENTS; index += 1) {
      const result = await hello('control', `client-${index}`)
      expect(result.response.ok).toBe(true)
      controls.push(result.socket)
    }
    await expect(hello('control', 'control-overflow')).resolves.toMatchObject({
      response: { ok: false, retryable: true, error: expect.stringContaining('control-client') }
    })
    expect(state.clients.size).toBe(DAEMON_MAX_CONTROL_CLIENTS)

    for (let index = 0; index < DAEMON_MAX_STREAM_ATTACHMENTS; index += 1) {
      await expect(hello('stream', `client-${index}`)).resolves.toMatchObject({
        response: { ok: true }
      })
    }
    await expect(hello('stream', `client-${DAEMON_MAX_STREAM_ATTACHMENTS}`)).resolves.toMatchObject(
      {
        response: {
          ok: false,
          retryable: true,
          error: expect.stringContaining('stream-attachment')
        }
      }
    )

    controls[0].destroy()
    await waitFor(() => state.clients.size === DAEMON_MAX_CONTROL_CLIENTS - 1)
    await expect(hello('control', 'replacement-control')).resolves.toMatchObject({
      response: { ok: true }
    })
    await expect(hello('stream', `client-${DAEMON_MAX_STREAM_ATTACHMENTS}`)).resolves.toMatchObject(
      {
        response: { ok: true }
      }
    )
  })

  it('bounds concurrent response construction and cleans ownership after disconnect', async () => {
    let finishPreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const preparePtySpawn = vi.fn(() => preparation)
    await startServer(preparePtySpawn)
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const state = server as unknown as DaemonServerAdmissionState

    const maxLargeResponses =
      DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT / DAEMON_RESPONSE_RESERVATION_BYTES
    const pending = Array.from({ length: maxLargeResponses }, (_, index) =>
      client!
        .request('createOrAttach', {
          sessionId: `pending-${index}`,
          cols: 80,
          rows: 24
        })
        .catch((error: unknown) => error)
    )
    await waitFor(() => preparePtySpawn.mock.calls.length === maxLargeResponses)
    await expect(
      client.request('createOrAttach', {
        sessionId: 'request-overflow',
        cols: 80,
        rows: 24
      })
    ).rejects.toThrow('request capacity exceeded')
    expect(state.activeRequestCount).toBe(maxLargeResponses)
    expect(state.activeResponseBytes).toBe(DAEMON_MAX_ACTIVE_RESPONSE_BYTES_PER_CLIENT)
    expect(state.pendingPtySpawnPreparations.size).toBe(maxLargeResponses)

    client.disconnect()
    finishPreparation()
    await Promise.all(pending)
    await waitFor(
      () =>
        state.activeRequestCount === 0 &&
        state.activeRequestBytes === 0 &&
        state.activeResponseBytes === 0 &&
        state.pendingPtySpawnPreparations.size === 0
    )
  })

  it('keeps the independent active-request cap for small response methods', async () => {
    let finishHealthCheck!: () => void
    const healthCheck = new Promise<void>((resolve) => {
      finishHealthCheck = resolve
    })
    const ptySpawnHealthCheck = vi.fn(() => healthCheck)
    await startServer(undefined, ptySpawnHealthCheck)
    const { socket, response } = await hello('control', 'active-request-cap-client')
    expect(response.ok).toBe(true)
    const state = server as unknown as DaemonServerAdmissionState

    for (let index = 0; index < DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT; index += 1) {
      socket.write(
        encodeNdjson({ id: `pending-${index}`, type: 'ptySpawnHealth', payload: undefined })
      )
    }
    await waitFor(
      () => ptySpawnHealthCheck.mock.calls.length === DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT
    )
    const overflowResponse = readJsonLine(socket)
    socket.write(encodeNdjson({ id: 'overflow', type: 'ptySpawnHealth', payload: undefined }))
    await expect(overflowResponse).resolves.toMatchObject({
      id: 'overflow',
      ok: false,
      error: expect.stringContaining('request capacity exceeded')
    })

    socket.destroy()
    finishHealthCheck()
    await waitFor(() => state.activeRequestCount === 0 && state.activeRequestBytes === 0)
  })

  it('enforces the per-client retained-byte budget independently of request count', async () => {
    let finishPreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve
    })
    const preparePtySpawn = vi.fn(() => preparation)
    await startServer(preparePtySpawn)
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const state = server as unknown as DaemonServerAdmissionState
    const connected = [...state.clients.values()][0]
    const request = (id: string): DaemonRequest => ({
      id,
      type: 'createOrAttach',
      payload: { sessionId: id, cols: 80, rows: 24 }
    })

    state.dispatchRequest(
      connected.controlSocket,
      connected.clientId,
      request('within-byte-budget'),
      DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT - 1024
    )
    await waitFor(() => preparePtySpawn.mock.calls.length === 1)
    state.dispatchRequest(
      connected.controlSocket,
      connected.clientId,
      request('over-byte-budget'),
      2048
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(preparePtySpawn).toHaveBeenCalledOnce()
    expect(connected.activeRequestCount).toBe(1)

    client.disconnect()
    finishPreparation()
    await waitFor(() => state.activeRequestCount === 0 && state.activeRequestBytes === 0)
  })

  it('holds idle retirement until admitted work releases after disconnect', async () => {
    let finishHealthCheck!: () => void
    const healthCheck = new Promise<void>((resolve) => {
      finishHealthCheck = resolve
    })
    const ptySpawnHealthCheck = vi.fn(() => healthCheck)
    const onIdleShutdown = vi.fn()
    server = new DaemonServer({
      socketPath,
      tokenPath,
      ptySpawnHealthCheck,
      onIdleShutdown,
      spawnSubprocess: () => {
        throw new Error('Test unexpectedly spawned a subprocess')
      }
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const state = server as unknown as DaemonServerAdmissionState

    const pending = client.request('ptySpawnHealth', undefined).catch((error: unknown) => error)
    await waitFor(() => ptySpawnHealthCheck.mock.calls.length === 1)
    client.disconnect()
    await pending
    await waitFor(() => state.transportSockets.size === 0)
    expect(state.activeRequestCount).toBe(1)
    expect(onIdleShutdown).not.toHaveBeenCalled()

    finishHealthCheck()
    await waitFor(() => state.activeRequestCount === 0 && onIdleShutdown.mock.calls.length === 1)
  })
})
