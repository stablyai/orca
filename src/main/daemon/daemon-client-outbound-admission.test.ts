import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DAEMON_CLIENT_MAX_CONTROL_BUFFERED_BYTES,
  DAEMON_CLIENT_MAX_PENDING_REQUESTS,
  DAEMON_CLIENT_MAX_REQUEST_LINE_BYTES,
  DaemonClient
} from './client'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type FakeControlSocket = {
  writableLength: number
  write: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function createConnectedClient(): {
  client: DaemonClient
  socket: FakeControlSocket
  pendingRequests: Map<string, PendingRequest>
} {
  const client = new DaemonClient({ socketPath: 'unused', tokenPath: 'unused' })
  const socket: FakeControlSocket = {
    writableLength: 0,
    write: vi.fn(() => true),
    destroy: vi.fn()
  }
  const pendingRequests = new Map<string, PendingRequest>()
  const state = client as unknown as {
    connected: boolean
    controlSocket: FakeControlSocket
    pendingRequests: Map<string, PendingRequest>
  }
  state.connected = true
  state.controlSocket = socket
  state.pendingRequests = pendingRequests
  return { client, socket, pendingRequests }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DaemonClient outbound admission', () => {
  it('rejects before serialization when the pending request cap is full', async () => {
    vi.useFakeTimers()
    const { client, socket, pendingRequests } = createConnectedClient()
    for (let index = 0; index < DAEMON_CLIENT_MAX_PENDING_REQUESTS; index += 1) {
      pendingRequests.set(`request-${index}`, {
        resolve: () => {},
        reject: () => {},
        timer: setTimeout(() => {}, 60_000)
      })
    }

    await expect(
      client.request('write', { data: 'x'.repeat(DAEMON_CLIENT_MAX_REQUEST_LINE_BYTES) })
    ).rejects.toThrow('pending request limit')

    expect(socket.write).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(DAEMON_CLIENT_MAX_PENDING_REQUESTS)
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer)
    }
  })

  it('rejects a request whose serialized line exceeds the daemon contract', async () => {
    const { client, socket, pendingRequests } = createConnectedClient()

    await expect(
      client.request('write', {
        data: 'x'.repeat(DAEMON_CLIENT_MAX_REQUEST_LINE_BYTES)
      })
    ).rejects.toThrow()

    expect(socket.write).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(0)
  })

  it('rejects and closes before growing a saturated control buffer', async () => {
    const { client, socket, pendingRequests } = createConnectedClient()
    socket.writableLength = DAEMON_CLIENT_MAX_CONTROL_BUFFERED_BYTES

    await expect(client.request('listSessions', undefined)).rejects.toThrow('control buffer limit')

    expect(socket.write).not.toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(pendingRequests.size).toBe(0)
  })

  it('releases request admission when socket.write throws', async () => {
    vi.useFakeTimers()
    const { client, socket, pendingRequests } = createConnectedClient()
    socket.write.mockImplementation(() => {
      throw new Error('write failed')
    })

    await expect(client.request('listSessions', undefined)).rejects.toThrow('write failed')

    expect(pendingRequests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a notification and closes before growing a saturated control buffer', () => {
    const { client, socket } = createConnectedClient()
    socket.writableLength = DAEMON_CLIENT_MAX_CONTROL_BUFFERED_BYTES

    client.notify('write', { sessionId: 'session-a', data: 'hello' })

    expect(socket.write).not.toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalledOnce()
  })
})
